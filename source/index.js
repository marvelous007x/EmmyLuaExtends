'use strict';

const vscode = require('vscode');
const fs = require('fs');
const path = require('path');

const { parseMeta, sourceForLine, extractSymbol, findInSource } = require('./meta');

const COMMAND_ID = 'emmyluaExtends.gotoSourceDefinition';
const CONFIG_FILE_NAME = 'emmylua-extends.json';
const DEFAULT_META_DIR_NAME = '_meta';

/** uri string -> { lines, fileSource, classLines, classSources } */
const metaCache = new Map();
let disposables = [];

// meta 目录名和 pfb 配置共用一个文件：workspace 的 .vscode/emmylua-extends.json
//   { "metaDirName": "_meta" }
function metaDirName(uri) {
    const folder =
        vscode.workspace.getWorkspaceFolder(uri) ||
        (vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders[0]);
    if (!folder) {
        return DEFAULT_META_DIR_NAME;
    }

    const configPath = path.join(folder.uri.fsPath, '.vscode', CONFIG_FILE_NAME);
    try {
        let text = fs.readFileSync(configPath, 'utf8');
        if (text.charCodeAt(0) === 0xFEFF) {
            text = text.slice(1);
        }
        const config = JSON.parse(text);
        if (config && typeof config.metaDirName === 'string' && config.metaDirName.trim()) {
            return config.metaDirName.trim();
        }
    } catch (e) {
        // 文件不存在或格式错误时用默认值
    }
    return DEFAULT_META_DIR_NAME;
}

function isMetaUri(uri) {
    if (!uri || uri.scheme !== 'file') {
        return false;
    }
    const segments = uri.fsPath.replace(/\\/g, '/').split('/');
    return segments.includes(metaDirName(uri));
}

async function readText(uri) {
    const open = vscode.workspace.textDocuments.find((d) => d.uri.toString() === uri.toString());
    if (open) {
        return open.getText();
    }
    const data = await vscode.workspace.fs.readFile(uri);
    return Buffer.from(data).toString('utf8');
}

async function getMetaInfo(uri) {
    const key = uri.toString();
    const hit = metaCache.get(key);
    if (hit) {
        return hit;
    }

    let text;
    try {
        text = await readText(uri);
    } catch (e) {
        return null;
    }

    const info = parseMeta(text);
    metaCache.set(key, info);
    return info;
}

function normalizeLocations(result) {
    const out = [];
    if (!Array.isArray(result)) {
        return out;
    }
    for (const item of result) {
        if (item && item.targetUri) {
            out.push(new vscode.Location(item.targetUri, item.targetSelectionRange || item.targetRange));
        } else if (item && item.uri && item.range) {
            out.push(item);
        }
    }
    return out;
}

async function mapLocation(loc) {
    if (!isMetaUri(loc.uri)) {
        return null;
    }

    const info = await getMetaInfo(loc.uri);
    if (!info) {
        return null;
    }

    const line = loc.range.start.line;
    const relSource = sourceForLine(info, line);
    if (!relSource) {
        return null;
    }

    const sym = extractSymbol(info.lines[line] || '');
    if (!sym) {
        return null;
    }

    const folder = vscode.workspace.getWorkspaceFolder(loc.uri);
    if (!folder) {
        return null;
    }

    const sourceUri = vscode.Uri.joinPath(folder.uri, ...relSource.replace(/\\/g, '/').split('/'));
    let text;
    try {
        text = await readText(sourceUri);
    } catch (e) {
        return null;
    }

    const found = findInSource(text.split(/\r?\n/), sym);
    if (!found) {
        return null;
    }
    const start = new vscode.Position(found.line, found.character);
    const end = new vscode.Position(found.line, found.character + found.length);
    return new vscode.Location(sourceUri, new vscode.Range(start, end));
}

async function openLocation(loc) {
    const doc = await vscode.workspace.openTextDocument(loc.uri);
    await vscode.window.showTextDocument(doc, { selection: loc.range, preview: true });
}

function dedupe(locations) {
    const seen = new Set();
    const out = [];
    for (const loc of locations) {
        const key = loc.uri.toString() + '#' + loc.range.start.line;
        if (seen.has(key)) {
            continue;
        }
        seen.add(key);
        out.push(loc);
    }
    return out;
}

async function gotoSourceDefinition() {
    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.document.languageId !== 'lua') {
        return vscode.commands.executeCommand('editor.action.revealDefinition');
    }

    let definitions = [];
    try {
        const result = await vscode.commands.executeCommand(
            'vscode.executeDefinitionProvider',
            editor.document.uri,
            editor.selection.active
        );
        definitions = normalizeLocations(result);
    } catch (e) {
        definitions = [];
    }

    if (definitions.length === 0) {
        return vscode.commands.executeCommand('editor.action.revealDefinition');
    }

    const mapped = [];
    for (const loc of definitions) {
        const target = await mapLocation(loc);
        if (target) {
            mapped.push(target);
        }
    }

    if (mapped.length > 0) {
        return openLocation(dedupe(mapped)[0]);
    }

    if (definitions.length === 1) {
        return openLocation(definitions[0]);
    }

    return vscode.commands.executeCommand('editor.action.revealDefinition');
}

function activate() {
    disposables.push(
        vscode.commands.registerCommand(COMMAND_ID, gotoSourceDefinition),
        vscode.workspace.onDidChangeTextDocument((e) => {
            metaCache.delete(e.document.uri.toString());
        }),
        vscode.workspace.onDidCloseTextDocument((e) => {
            metaCache.delete(e.document.uri.toString());
        })
    );

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
    metaCache.clear();
}

module.exports = {
    activate,
    dispose,
    // 便于单独测试
    metaDirName,
    isMetaUri,
};
