'use strict';

// 解析 _meta 注解文件（---@class 块 + --source:），以及在源文件里定位符号。
// 纯函数，不依赖 vscode，可用 Node 单独测试。

function parseMeta(text) {
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

module.exports = {
    parseMeta,
    sourceForLine,
    extractSymbol,
    findInSource,
};
