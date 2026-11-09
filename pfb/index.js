'use strict';

const vscode = require('vscode');
const fs = require('fs');
const path = require('path');

const { scanDocument, classAt, normalizePfbPath } = require('./annotations');
const { parsePrefabFields } = require('./prefab');

const CONFIG_FILE_NAME = 'emmylua-extends.json';
const DEFAULT_PREFAB_ROOT = '../GameClient/Assets/GameResources/UI';
const SELF_RE = /(^|[^A-Za-z0-9_$.])self\.([A-Za-z_]\w*)?$/;

let cache = null;
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

function workspaceFolderFor(document) {
    return (
        vscode.workspace.getWorkspaceFolder(document.uri) ||
        (vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders[0]) ||
        null
    );
}

// 配置放在 workspace 的 .vscode/emmylua-extends.json，不读 settings.json：
//   { "enabled": true, "prefabRoot": "..." }
function readConfig(document) {
    const config = { enabled: true, prefabRoot: DEFAULT_PREFAB_ROOT, root: null };
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
            if (typeof json.prefabRoot === 'string' && json.prefabRoot.trim()) {
                config.prefabRoot = json.prefabRoot.trim();
            }
        }
    } catch (e) {
        if (e.code !== 'ENOENT') {
            warnOnce('config:' + configPath, '读取配置失败，使用默认配置：' + configPath);
        }
    }

    config.root = path.isAbsolute(config.prefabRoot)
        ? config.prefabRoot
        : path.resolve(folder.uri.fsPath, config.prefabRoot);
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

function getFields(docCache, root, rawPfbPath) {
    const relative = normalizePfbPath(rawPfbPath);
    if (!relative) {
        return null;
    }
    if (!root) {
        warnOnce('noprefabroot', '没有找到 workspace，无法解析 prefab 路径');
        return null;
    }
    const fullPath = path.resolve(root, relative + '.prefab');

    let stat;
    try {
        stat = fs.statSync(fullPath);
    } catch (e) {
        warnOnce('missing:' + fullPath, 'prefab 不存在：' + fullPath);
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

function warm(document) {
    try {
        const config = readConfig(document);
        if (!config.enabled || !config.root) {
            return;
        }
        const docCache = ensureCache(document);
        for (const classInfo of docCache.scan.classes.values()) {
            if (classInfo.pfb) {
                getFields(docCache, config.root, classInfo.pfb);
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

        const fields = getFields(docCache, config.root, classInfo.pfb);
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
        vscode.languages.registerCompletionItemProvider('lua', { provideCompletionItems }, '.')
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
    warned.clear();
    output = null;
}

module.exports = {
    activate,
    dispose,
};
