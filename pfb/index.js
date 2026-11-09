'use strict';

const vscode = require('vscode');
const fs = require('fs');
const path = require('path');

const { scanDocument, classAt, normalizePfbPath, deriveUnityRoot, resolvePrefabFile } = require('./annotations');
const { parsePrefabFields } = require('./prefab');
const { buildMetaIndex, membersOf, inferFieldType } = require('./metaTypes');

const CONFIG_FILE_NAME = 'emmylua-extends.json';
const DEFAULT_PREFAB_ROOT = '../GameClient/Assets/GameResources/UI';
const DEFAULT_META_DIR_NAME = '_meta';
const SELF_RE = /(^|[^A-Za-z0-9_$.])self\.([A-Za-z_]\w*)?$/;
// 任意 a.b.c. / a.b.c: 链路；链路上的字段名和成员名用来逐级推断类型。
const CHAIN_RE = /((?:[A-Za-z_]\w*\.)+[A-Za-z_]\w*)[.:]([A-Za-z_]\w*)?$/;

let cache = null;
let metaCache = null;
let disposables = [];
let output = null;
let warned = new Set();

function logError(error) {
    if (output) {
        output.appendLine('[error] ' + (error && error.stack ? error.stack : String(error)));
    }
}

function warnOnce(key, message) {
    if (warned.has(key)) {
        return;
    }
    warned.add(key);
    if (output) {
        output.appendLine('[warn] ' + message);
    }
}

// 只在第一次出现时弹窗，避免每次补全都打扰。
function reportError(key, message) {
    if (warned.has(key)) {
        return;
    }
    warned.add(key);
    if (output) {
        output.appendLine('[error] ' + message);
    }
    vscode.window.showErrorMessage(message);
}

function workspaceFolderFor(document) {
    return (
        vscode.workspace.getWorkspaceFolder(document.uri) ||
        (vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders[0]) ||
        null
    );
}

// 配置放在 workspace 的 .vscode/emmylua-extends.json，不读 settings.json：
//   { "enabled": true, "unityProjectRoot": "../GameClient", "prefabRoot": "Assets/GameResources/UI" }
// unityProjectRoot 可省略；省略时 prefabRoot 按原方式相对 workspace 解析。
function readConfig(document) {
    const config = {
        enabled: true,
        unityProjectRoot: '',
        prefabRoot: DEFAULT_PREFAB_ROOT,
        metaDirName: DEFAULT_META_DIR_NAME,
        root: null,
        unityRoot: null,
        metaRoot: null,
    };
    const folder = workspaceFolderFor(document);
    if (!folder) {
        return config;
    }

    const configPath = path.join(folder.uri.fsPath, '.vscode', CONFIG_FILE_NAME);
    try {
        let text = fs.readFileSync(configPath, 'utf8');
        if (text.charCodeAt(0) === 0xFEFF) {
            text = text.slice(1);
        }
        const json = JSON.parse(text);
        if (json) {
            if (json.enabled === false) {
                config.enabled = false;
            }
            if (typeof json.unityProjectRoot === 'string' && json.unityProjectRoot.trim()) {
                config.unityProjectRoot = json.unityProjectRoot.trim();
            }
            if (typeof json.prefabRoot === 'string' && json.prefabRoot.trim()) {
                config.prefabRoot = json.prefabRoot.trim();
            }
            if (typeof json.metaDirName === 'string' && json.metaDirName.trim()) {
                config.metaDirName = json.metaDirName.trim();
            }
        }
    } catch (e) {
        if (e.code !== 'ENOENT') {
            warnOnce('config:' + configPath, '读取配置失败，使用默认配置：' + configPath);
        }
    }

    const base = folder.uri.fsPath;
    if (config.unityProjectRoot) {
        config.unityRoot = path.isAbsolute(config.unityProjectRoot)
            ? config.unityProjectRoot
            : path.resolve(base, config.unityProjectRoot);
    }

    config.root = config.unityRoot
        ? path.isAbsolute(config.prefabRoot)
            ? config.prefabRoot
            : path.resolve(config.unityRoot, config.prefabRoot)
        : path.isAbsolute(config.prefabRoot)
            ? config.prefabRoot
            : path.resolve(base, config.prefabRoot);

    config.metaRoot = path.isAbsolute(config.metaDirName)
        ? config.metaDirName
        : path.resolve(base, config.metaDirName);

    // 旧配置没写 unityProjectRoot 时，从 prefabRoot 的 Assets 段反推 Unity 工程根，
    // 这样 Assets/... 形式的 --pfb: 也能直接解析。
    if (!config.unityRoot) {
        config.unityRoot = deriveUnityRoot(config.root);
    }
    return config;
}

function ensureCache(document) {
    const docUri = document.uri.toString();
    if (!cache || cache.docUri !== docUri) {
        cache = {
            docUri,
            version: -1,
            scan: null,
            prefabs: new Map(),
        };
    }
    if (cache.version !== document.version || !cache.scan) {
        cache.scan = scanDocument(document.getText());
        cache.version = document.version;
    }
    return cache;
}

function getFields(docCache, config, rawPfbPath) {
    if (!config.root) {
        warnOnce('noprefabroot', '没有找到 workspace，无法解析 prefab 路径');
        return null;
    }
    const fullPath = resolvePrefabFile(config, rawPfbPath);
    if (!fullPath) {
        reportError('resolve:' + rawPfbPath, 'pfb: 无法解析 prefab 路径：' + rawPfbPath);
        return null;
    }

    let stat;
    try {
        stat = fs.statSync(fullPath);
    } catch (e) {
        reportError('missing:' + fullPath, 'pfb: 找不到 prefab 文件：' + fullPath);
        return null;
    }

    const hit = docCache.prefabs.get(fullPath);
    if (hit && hit.mtimeMs === stat.mtimeMs) {
        return hit.fields;
    }

    let text;
    try {
        text = fs.readFileSync(fullPath, 'utf8');
    } catch (e) {
        warnOnce('read:' + fullPath, '读取 prefab 失败：' + fullPath);
        return null;
    }

    const result = parsePrefabFields(text);
    docCache.prefabs.set(fullPath, { mtimeMs: stat.mtimeMs, fields: result.fields });
    if (!result.matched) {
        warnOnce('nomatch:' + fullPath, 'prefab 没有匹配到绑定规则：' + fullPath);
    }
    return result.fields;
}

// meta 目录里的注解按 mtime/size 组合成戳，变了才重新解析。
function metaIndexFor(config) {
    const dir = config.metaRoot;
    if (!dir) {
        return null;
    }

    let names;
    try {
        names = fs.readdirSync(dir).filter((name) => /\.lua$/i.test(name)).sort();
    } catch (e) {
        warnOnce('meta:' + dir, '找不到 meta 目录，self.<字段>. 的成员补全不可用：' + dir);
        return null;
    }

    const stampParts = [];
    const files = [];
    for (const name of names) {
        const fullPath = path.join(dir, name);
        try {
            const stat = fs.statSync(fullPath);
            stampParts.push(name + ':' + stat.mtimeMs + ':' + stat.size);
            files.push(fullPath);
        } catch (e) {
            // 本次跳过
        }
    }

    const stamp = stampParts.join('|');
    if (metaCache && metaCache.dir === dir && metaCache.stamp === stamp) {
        return metaCache.index;
    }

    const texts = [];
    for (const fullPath of files) {
        try {
            texts.push(fs.readFileSync(fullPath, 'utf8'));
        } catch (e) {
            // 本次跳过
        }
    }

    const index = buildMetaIndex(texts);
    metaCache = { dir, stamp, index };
    return index;
}

// 从链路里第一个能按字段名推断出类型的段开始，逐级查 meta 成员的类型。
// 例如 t.mPfbX.transform. -> mPfbX 推断为 GameObject -> transform 成员是 Transform。
function resolveChainType(index, segments) {
    let start = -1;
    for (let i = 0; i < segments.length; i++) {
        if (inferFieldType(segments[i])) {
            start = i;
            break;
        }
    }
    if (start < 0) {
        return null;
    }

    let typeName = inferFieldType(segments[start]);
    for (let i = start + 1; i < segments.length; i++) {
        const member = membersOf(index, typeName).find((m) => m.name === segments[i]);
        if (!member) {
            return null;
        }
        typeName = memberClass(index, member.type);
        if (!typeName) {
            return null;
        }
    }
    return typeName;
}

// 成员类型可能是 `CS.X.Y`、`CS.X.Y|nil` 等，取第一个在 meta 索引里存在的类型。
function memberClass(index, typeStr) {
    for (let part of String(typeStr).split('|')) {
        part = part.trim();
        if (/^[A-Za-z_][\w.]*$/.test(part) && index.has(part)) {
            return part;
        }
    }
    return null;
}

// <任意实例>....<字段>. 的成员补全：按链路推断类型，再从 meta 里取成员。
// 不要求接收者是 self，字段也不必真的挂在该实例上（table、userdata 都可以）。
function provideFieldMembers(document, position, before, match) {
    const segments = match[1].split('.');
    const partial = match[2] || '';
    const chainStart = before.length - partial.length - match[1].length - 1;
    if (before.slice(0, chainStart).includes('--')) {
        return undefined;
    }

    const config = readConfig(document);
    if (!config.enabled) {
        return undefined;
    }

    // self 上显式写了 ---@field 的字段交给 EmmyLua 自己处理，避免重复补全。
    if (segments[0] === 'self' && segments.length > 1) {
        const classInfo = classAt(ensureCache(document).scan, position.line);
        if (classInfo && classInfo.fields.has(segments[1])) {
            return undefined;
        }
    }

    const index = metaIndexFor(config);
    if (!index) {
        return undefined;
    }
    const typeName = resolveChainType(index, segments);
    if (!typeName) {
        return undefined;
    }
    const members = membersOf(index, typeName);
    if (members.length === 0) {
        return undefined;
    }

    const range = new vscode.Range(
        position.line,
        position.character - partial.length,
        position.line,
        position.character
    );
    const items = [];
    for (const member of members) {
        const isMethod = /^fun\b/.test(member.type);
        const item = new vscode.CompletionItem(
            member.name,
            isMethod ? vscode.CompletionItemKind.Method : vscode.CompletionItemKind.Field
        );
        item.range = range;
        item.detail = member.type;
        items.push(item);
    }
    return items.length > 0 ? items : undefined;
}

function warm(document) {
    try {
        const config = readConfig(document);
        if (!config.enabled || !config.root) {
            return;
        }
        const docCache = ensureCache(document);
        for (const classInfo of docCache.scan.classes.values()) {
            if (classInfo.pfb) {
                getFields(docCache, config, classInfo.pfb);
            }
        }
    } catch (e) {
        logError(e);
    }
}

function provideCompletionItems(document, position) {
    try {
        if (document.languageId !== 'lua') {
            return undefined;
        }

        const before = document.lineAt(position.line).text.slice(0, position.character);

        const chainMatch = CHAIN_RE.exec(before);
        if (chainMatch) {
            return provideFieldMembers(document, position, before, chainMatch);
        }

        const match = SELF_RE.exec(before);
        if (!match) {
            return undefined;
        }

        const partial = match[2] || '';
        const selfStart = before.length - partial.length - 'self.'.length;
        if (before.slice(0, selfStart).includes('--')) {
            return undefined;
        }

        const config = readConfig(document);
        if (!config.enabled) {
            return undefined;
        }

        const docCache = ensureCache(document);
        const classInfo = classAt(docCache.scan, position.line);
        if (!classInfo || !classInfo.pfb) {
            return undefined;
        }

        const fields = getFields(docCache, config, classInfo.pfb);
        if (!fields || fields.length === 0) {
            return undefined;
        }

        const range = new vscode.Range(
            position.line,
            position.character - partial.length,
            position.line,
            position.character
        );
        const detail = 'pfb: ' + normalizePfbPath(classInfo.pfb);
        const items = [];
        for (const field of fields) {
            if (classInfo.fields.has(field)) {
                continue;
            }
            const item = new vscode.CompletionItem(field, vscode.CompletionItemKind.Field);
            item.range = range;
            item.detail = detail;
            items.push(item);
        }
        return items.length > 0 ? items : undefined;
    } catch (e) {
        logError(e);
        return undefined;
    }
}

function activate(context) {
    output = vscode.window.createOutputChannel('EmmyLua Prefab Fields');

    disposables.push(output);
    disposables.push(
        vscode.languages.registerCompletionItemProvider('lua', { provideCompletionItems }, '.', ':')
    );

    disposables.push(
        vscode.window.onDidChangeActiveTextEditor((editor) => {
            if (!editor) {
                return;
            }
            if (editor.document.languageId === 'lua') {
                warm(editor.document);
            } else {
                cache = null;
            }
        })
    );

    disposables.push(
        vscode.workspace.onDidCloseTextDocument((document) => {
            if (cache && cache.docUri === document.uri.toString()) {
                cache = null;
            }
        })
    );

    const active = vscode.window.activeTextEditor;
    if (active && active.document.languageId === 'lua') {
        warm(active.document);
    }

    return new vscode.Disposable(dispose);
}

function dispose() {
    for (const disposable of disposables) {
        try {
            disposable.dispose();
        } catch (e) {
            // ignore
        }
    }
    disposables = [];
    cache = null;
    metaCache = null;
    warned.clear();
    output = null;
}

module.exports = {
    activate,
    dispose,
};
