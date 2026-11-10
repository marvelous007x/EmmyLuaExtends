'use strict';

// 从 _meta 注解里建立「类型 -> 成员」索引，用于 self.<pfb 字段>. 的二段补全。
// 只解析 ---@class / ---@field，沿父类向上收集成员；纯函数，可用 Node 单独测试。

const META_CLASS_RE = /^\s*---@class\s+(?:\((?:partial|exact)\)\s+)?([A-Za-z_][\w.]*)\s*(?::\s*(.*?))?\s*$/;
const META_FIELD_RE = /^\s*---@field\s+([A-Za-z_]\w*)\s+(.+?)\s*$/;

// 与 LuaGo:InitObjects 的绑定前缀一致：Main "m"、Child "_m"、Grand "gm"。
// 取最长匹配，所以 gm/_m 要排在 m 前面。
const BIND_PREFIXES = ['gm', '_m', 'm'];

// 与 LuaGo:BindComponent 的关键字判断顺序一致。
const BIND_TYPES = [
    ['GO', 'CS.UnityEngine.RectTransform'],
    ['Pfb', 'CS.UnityEngine.GameObject'],
    ['Btn', 'CS.UnityEngine.UI.Button'],
    ['Toggle', 'CS.UnityEngine.UI.Toggle'],
    ['Input', 'CS.UnityEngine.UI.InputField'],
    ['Text', 'CS.UnityEngine.UI.Text'],
    ['Number', 'UINumberEffect'],
    ['Img', 'CS.UnityEngine.UI.Image'],
    ['RImg', 'CS.UnityEngine.UI.RawImage'],
    ['Scroll', 'CS.UnityEngine.UI.ScrollRect'],
    ['Loop', 'SuperScrollView.LoopListView2'],
    ['Slider', 'CS.UnityEngine.UI.Slider'],
];

function parseParents(raw) {
    if (!raw) {
        return [];
    }
    const out = [];
    for (let part of raw.split(',')) {
        part = part.trim();
        if (part && /^[A-Za-z_][\w.]*$/.test(part) && !out.includes(part)) {
            out.push(part);
        }
    }
    return out;
}

// 把一段 meta 文本解析进 classes；同一类型可能分在多处（partial）声明，按字段合并。
// filePath 用于记录字段的声明位置，供 F12 跳转。
function parseMetaText(text, classes, filePath) {
    const index = classes || new Map();
    let current = null;

    const lines = text.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];

        const classMatch = META_CLASS_RE.exec(line);
        if (classMatch) {
            const name = classMatch[1];
            let info = index.get(name);
            if (!info) {
                info = { name, parents: [], fields: new Map(), locations: new Map() };
                index.set(name, info);
            }
            for (const parent of parseParents(classMatch[2])) {
                if (!info.parents.includes(parent)) {
                    info.parents.push(parent);
                }
            }
            current = info;
            continue;
        }

        if (!current) {
            continue;
        }

        const fieldMatch = META_FIELD_RE.exec(line);
        if (fieldMatch) {
            const name = fieldMatch[1];
            if (!current.fields.has(name)) {
                current.fields.set(name, fieldMatch[2]);
                current.locations.set(name, {
                    file: filePath || '',
                    line: i,
                    character: line.indexOf(name),
                });
            }
            continue;
        }

        if (/^\s*---@/.test(line) || /^\s*--/.test(line) || /^\s*$/.test(line)) {
            continue;
        }

        // 类声明的第一行代码（如 `CS.UnityEngine.UI.Image = {}`），注解块到此结束。
        current = null;
    }

    return index;
}

// entries: 文本数组，或 { file, text } 数组（file 用于记录字段位置）。
function buildMetaIndex(entries) {
    const index = new Map();
    for (const entry of entries) {
        if (typeof entry === 'string') {
            parseMetaText(entry, index);
        } else if (entry && typeof entry.text === 'string') {
            parseMetaText(entry.text, index, entry.file);
        }
    }
    return index;
}

function collectMembers(index, typeName, out, seen) {
    if (seen.has(typeName)) {
        return;
    }
    seen.add(typeName);

    const info = index.get(typeName);
    if (!info) {
        return;
    }
    for (const [name, type] of info.fields) {
        if (!out.has(name)) {
            const loc = info.locations.get(name) || {};
            out.set(name, { type, file: loc.file || '', line: loc.line, character: loc.character });
        }
    }
    for (const parent of info.parents) {
        collectMembers(index, parent, out, seen);
    }
}

// 子类成员优先；沿父类链补齐。返回 [{ name, type, file, line, character }]。
function membersOf(index, typeName) {
    const out = new Map();
    const seen = new Set();
    collectMembers(index, typeName, out, seen);
    if (out.size === 0 && !typeName.startsWith('CS.')) {
        // 兼容 UINumberEffect 这类写法可能是 CS.UINumberEffect 的情况。
        collectMembers(index, 'CS.' + typeName, out, seen);
    }
    return Array.from(out, ([name, info]) => ({
        name,
        type: info.type,
        file: info.file,
        line: info.line,
        character: info.character,
    }));
}

// pfb 字段名 -> Unity 组件类型全名；推断不出（如落到 LuaBehaviour）返回 null。
function inferFieldType(fieldName) {
    let bare = String(fieldName);
    for (const prefix of BIND_PREFIXES) {
        if (bare.startsWith(prefix)) {
            bare = bare.slice(prefix.length);
            break;
        }
    }
    for (const [keyword, type] of BIND_TYPES) {
        if (bare.startsWith(keyword)) {
            return type;
        }
    }
    return null;
}

module.exports = {
    buildMetaIndex,
    parseMetaText,
    membersOf,
    inferFieldType,
};
