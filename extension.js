'use strict';

const vscode = require('vscode');

const COMMAND_ID = 'emmyluaExtends.gotoSourceDefinition';
const CONFIG_SECTION = 'emmyluaExtends';

/** uri string -> { lines, fileSource, classLines, classSources } */
const metaCache = new Map();

function metaDirName() {
    return vscode.workspace.getConfiguration(CONFIG_SECTION).get('metaDirName', '_meta');
}

function isMetaUri(uri) {
    if (!uri || uri.scheme !== 'file') {
        return false;
    }
    const segments = uri.fsPath.replace(/\\/g, '/').split('/');
    return segments.includes(metaDirName());
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

    const lines = text.split(/\r?\n/);
    const info = {
        lines,
        fileSource: null,
        classLines: [],
        classSources: new Map(),
    };

    let lastClassLine = -1;
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (/^\s*---@class\s+/.test(line)) {
            lastClassLine = i;
            info.classLines.push(i);
            continue;
        }
        const m = /^\s*--source:\s*(\S+)\s*$/.exec(line);
        if (m) {
            if (lastClassLine >= 0) {
                info.classSources.set(lastClassLine, m[1]);
            } else {
                info.fileSource = m[1];
            }
        }
    }

    metaCache.set(key, info);
    return info;
}

function sourceForLine(info, line) {
    let classLine = -1;
    for (const cl of info.classLines) {
        if (cl > line) {
            break;
        }
        classLine = cl;
    }
    if (classLine >= 0 && info.classSources.has(classLine)) {
        return info.classSources.get(classLine);
    }
    return info.fileSource;
}

function escapeRegExp(text) {
    return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function extractSymbol(metaLine) {
    let m = /^\s*function\s+([A-Za-z_][\w]*(?:\.[A-Za-z_][\w]*)*)\s*([.:])\s*([A-Za-z_][\w]*)\s*\(/.exec(metaLine);
    if (m) {
        return { kind: 'method', owner: m[1], name: m[3] };
    }

    m = /^\s*function\s+([A-Za-z_][\w]*)\s*\(/.exec(metaLine);
    if (m) {
        return { kind: 'global', name: m[1] };
    }

    m = /^\s*---@field\s+(?:\[[^\]]*\]|([A-Za-z_][\w]*))\s+/.exec(metaLine);
    if (m) {
        return m[1] ? { kind: 'field', name: m[1] } : null;
    }

    m = /^\s*([A-Za-z_][\w.]*)\s*=\s*function\b/.exec(metaLine);
    if (m) {
        const parts = m[1].split('.');
        const name = parts.pop();
        return { kind: parts.length ? 'method' : 'global', owner: parts.join('.') || null, name };
    }

    m = /^\s*([A-Za-z_][\w.]*)\s*=\s*\{\s*\}\s*$/.exec(metaLine);
    if (m) {
        return { kind: 'class', name: m[1] };
    }

    m = /^\s*([A-Za-z_][\w.]*)\s*=\s*\S+.*$/.exec(metaLine);
    if (m) {
        return { kind: 'var', name: m[1] };
    }

    return null;
}

function findMatch(lines, pattern) {
    for (let i = 0; i < lines.length; i++) {
        const m = pattern.exec(lines[i]);
        if (m) {
            return { line: i, index: m.index, text: m[0] };
        }
    }
    return null;
}

function symbolMatch(found, name) {
    const idx = found.text.lastIndexOf(name);
    if (idx < 0) {
        return null;
    }
    return { line: found.line, character: found.index + idx, length: name.length };
}

function findInSource(lines, sym) {
    const name = escapeRegExp(sym.name);
    const owner = sym.owner ? escapeRegExp(sym.owner) : null;
    const patterns = [];

    if (sym.kind === 'method' && owner) {
        patterns.push(new RegExp('^\\s*function\\s+' + owner + '\\s*[.:]\\s*' + name + '\\s*\\('));
        patterns.push(
            new RegExp('^\\s*' + owner + '\\s*[.:\\[]\\s*["\']?' + name + '["\']?\\s*\\]?\\s*=\\s*function\\b')
        );
    } else if (sym.kind === 'global') {
        patterns.push(new RegExp('^\\s*function\\s+' + name + '\\s*\\('));
        patterns.push(new RegExp('^\\s*' + name + '\\s*=\\s*function\\b'));
    } else if (sym.kind === 'field') {
        patterns.push(new RegExp('^\\s*self\\.' + name + '\\s*='));
    } else if (sym.kind === 'class' || sym.kind === 'var') {
        patterns.push(new RegExp('^\\s*(?:local\\s+)?' + escapeRegExp(sym.name) + '\\s*='));
    }

    for (const pattern of patterns) {
        const found = findMatch(lines, pattern);
        if (!found) {
            continue;
        }
        const hit = symbolMatch(found, sym.name);
        if (hit) {
            return hit;
        }
    }

    return null;
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

function activate(context) {
    context.subscriptions.push(
        vscode.commands.registerCommand(COMMAND_ID, gotoSourceDefinition),
        vscode.workspace.onDidChangeTextDocument((e) => {
            metaCache.delete(e.document.uri.toString());
        }),
        vscode.workspace.onDidCloseTextDocument((e) => {
            metaCache.delete(e.document.uri.toString());
        }),
        vscode.workspace.onDidChangeConfiguration((e) => {
            if (e.affectsConfiguration(CONFIG_SECTION)) {
                metaCache.clear();
            }
        })
    );
}

function deactivate() {
    metaCache.clear();
}

module.exports = { activate, deactivate };
