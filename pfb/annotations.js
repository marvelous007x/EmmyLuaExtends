'use strict';

// 扫描当前 Lua 文件里的类注解，建立：
//   ---@class 类名 [: 父类]
//   --pfb: 相对 Assets/GameResources/UI 的路径（不带 .prefab）
// 并找出光标所在函数对应的类。

const CLASS_RE = /^\s*---@class\s+(?:\((?:partial|exact)\)\s+)?([A-Za-z_][\w.]*)\s*(?::\s*(.*?))?\s*$/;
const PFB_RE = /^\s*--pfb:\s*(.+?)\s*$/;
const FIELD_RE = /^\s*---@field\s+(?:\[\s*["']?([^\]"']+)["']?\s*\]|([A-Za-z_][\w]*))/;
const DECL_RE = /^\s*(?:local\s+)?([A-Za-z_][\w.]*)\s*=\s*(?:class|classRedPoint)\s*\(\s*["']([^"']*)["']\s*(?:,\s*(.*?))?\s*\)/;
const ASSIGN_RE = /^\s*(?:local\s+)?([A-Za-z_][\w.]*)\s*=/;
const FUNC_RE = /^\s*function\s+([A-Za-z_][\w.]*)\s*[.:]\s*([A-Za-z_]\w*)\s*\(/;
const FUNC_ASSIGN_RE = /^\s*([A-Za-z_][\w.]*)\s*[.:]\s*([A-Za-z_]\w*)\s*=\s*function\s*\(/;
const PLAIN_FUNC_RE = /^\s*(?:local\s+)?function\s+[A-Za-z_]/;

function parseParentList(raw) {
    if (!raw) {
        return [];
    }
    const out = [];
    for (let part of raw.split(',')) {
        part = part.trim().replace(/^LuaClass\./, '');
        if (part && /^[A-Za-z_][\w.]*$/.test(part) && !out.includes(part)) {
            out.push(part);
        }
    }
    return out;
}

function scanDocument(text) {
    const lines = text.split(/\r?\n/);
    const classes = new Map();
    const receiverToClass = new Map();
    let current = null;

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];

        const classMatch = CLASS_RE.exec(line);
        if (classMatch) {
            const name = classMatch[1];
            current = {
                name,
                parents: parseParentList(classMatch[2]),
                pfb: null,
                fields: new Set(),
                line: i,
            };
            classes.set(name, current);
            continue;
        }

        if (!current) {
            continue;
        }

        const pfbMatch = PFB_RE.exec(line);
        if (pfbMatch) {
            if (!current.pfb) {
                current.pfb = pfbMatch[1].trim();
            }
            continue;
        }

        const fieldMatch = FIELD_RE.exec(line);
        if (fieldMatch) {
            current.fields.add(fieldMatch[1] || fieldMatch[2]);
            continue;
        }

        if (/^\s*---@/.test(line) || /^\s*--/.test(line) || /^\s*$/.test(line)) {
            continue;
        }

        // 类声明的第一行代码，注解块到此结束。
        const declMatch = DECL_RE.exec(line);
        if (declMatch) {
            for (const parent of parseParentList(declMatch[3])) {
                if (!current.parents.includes(parent)) {
                    current.parents.push(parent);
                }
            }
            receiverToClass.set(declMatch[1], current.name);
        } else {
            const assignMatch = ASSIGN_RE.exec(line);
            if (assignMatch) {
                receiverToClass.set(assignMatch[1], current.name);
            }
        }
        current = null;
    }

    return { lines, classes, receiverToClass };
}

function indentOf(text) {
    const m = /^[ \t]*/.exec(text);
    return m ? m[0].length : 0;
}

// 找光标所在的 `function 接收者:方法`。跳过嵌套的无接收者 function，
// 顶层无接收者的 function 则直接返回 null。
function findReceiver(lines, line) {
    const cursorIndent = indentOf(lines[line] || '');
    for (let i = line; i >= 0; i--) {
        const text = lines[i];
        const m = FUNC_RE.exec(text) || FUNC_ASSIGN_RE.exec(text);
        if (m) {
            if (indentOf(text) <= cursorIndent) {
                return m[1];
            }
            continue;
        }
        if (PLAIN_FUNC_RE.test(text) && indentOf(text) === 0) {
            return null;
        }
    }
    return null;
}

function classAt(scan, line) {
    const receiver = findReceiver(scan.lines, line);
    if (!receiver) {
        return null;
    }
    if (scan.classes.has(receiver)) {
        return scan.classes.get(receiver);
    }
    const className = scan.receiverToClass.get(receiver);
    if (className && scan.classes.has(className)) {
        return scan.classes.get(className);
    }
    return null;
}

function normalizePfbPath(raw) {
    let p = String(raw).trim().replace(/\\/g, '/');
    p = p.replace(/^\/+/, '');
    p = p.replace(/^Assets\/GameResources\/UI\//, '');
    p = p.replace(/\.prefab$/i, '');
    return p;
}

module.exports = {
    scanDocument,
    classAt,
    normalizePfbPath,
    // 便于单独测试
    findReceiver,
    parseParentList,
};
