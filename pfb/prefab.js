'use strict';

// 从 Unity 文本 prefab 中提取 ---@field 需要的节点名。
// 规则与 Assets/_Local/Editor/Tools/GameObjectMenu.cs 里的
// LuaFields.GenerateLuaFields(GameObject go) 一致，只保留 fields，忽略 functions。
// 不处理嵌套 prefab（PrefabInstance 里的节点不会出现在本文件）。

function unquoteYaml(value) {
    if (value.length >= 2 && value[0] === "'" && value[value.length - 1] === "'") {
        return value.slice(1, -1).replace(/''/g, "'");
    }
    if (value.length >= 2 && value[0] === '"' && value[value.length - 1] === '"') {
        return value.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, '\\');
    }
    return value;
}

function parsePrefabText(text) {
    const rects = new Map(); // RectTransform fileID -> { goId, fatherId }
    const children = new Map(); // RectTransform fileID -> [child RectTransform fileID]
    const goNames = new Map(); // GameObject fileID -> name

    let type = 0;
    let id = 0;
    let goId = 0;
    let fatherId = 0;
    let childIds = [];
    let inChildren = false;
    let isRect = false;

    function flush() {
        if (isRect) {
            rects.set(id, { goId, fatherId });
            children.set(id, childIds);
        }
    }

    const lines = text.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];

        if (line.startsWith('--- !u!')) {
            flush();
            const m = /^--- !u!(\d+) &(\d+)/.exec(line);
            type = m ? Number(m[1]) : 0;
            id = m ? Number(m[2]) : 0;
            goId = 0;
            fatherId = 0;
            childIds = [];
            inChildren = false;
            isRect = type === 224 && !/\bstripped\b/.test(line);
            continue;
        }

        if (type === 1) {
            const m = /^  m_Name:\s?(.*)$/.exec(line);
            if (m) {
                goNames.set(id, unquoteYaml(m[1]));
            }
            continue;
        }

        if (type !== 224 || !isRect) {
            continue;
        }

        if (inChildren) {
            const cm = /^  - \{fileID: (\d+)\}/.exec(line);
            if (cm) {
                childIds.push(Number(cm[1]));
                continue;
            }
            inChildren = false;
        }

        let m = /^  m_GameObject: \{fileID: (\d+)\}/.exec(line);
        if (m) {
            goId = Number(m[1]);
            continue;
        }
        m = /^  m_Father: \{fileID: (\d+)\}/.exec(line);
        if (m) {
            fatherId = Number(m[1]);
            continue;
        }
        if (/^  m_Children:\s*$/.test(line)) {
            inChildren = true;
            childIds = [];
        }
    }

    flush();
    return { rects, children, goNames };
}

// 按 GetComponentsInChildren 的顺序（深度优先、根节点在前）列出节点名。
function orderedRectNames({ rects, children, goNames }) {
    const roots = [];
    for (const rectId of rects.keys()) {
        const rect = rects.get(rectId);
        if (!rect.fatherId || !rects.has(rect.fatherId)) {
            roots.push(rectId);
        }
    }

    const out = [];
    const visited = new Set();
    const visit = (rectId) => {
        if (visited.has(rectId)) {
            return;
        }
        visited.add(rectId);
        const rect = rects.get(rectId);
        if (rect && rect.goId) {
            const name = goNames.get(rect.goId);
            if (name !== undefined) {
                out.push(name);
            }
        }
        for (const childId of children.get(rectId) || []) {
            if (rects.has(childId)) {
                visit(childId);
            }
        }
    };

    for (const rootId of roots) {
        visit(rootId);
    }
    // 防御：层级不完整的节点也按文档顺序补上。
    for (const rectId of rects.keys()) {
        visit(rectId);
    }
    return out;
}

function extractFields(names) {
    const fields = [];
    let matched = false;
    let separator = ' ';
    let start = '';

    for (const name of names) {
        if (!matched) {
            if (name.startsWith('m') || name.startsWith(':')) {
                matched = true;
                separator = ':';
                start = 'm';
            } else if (name.startsWith('_m') || name.includes('.')) {
                matched = true;
                separator = '.';
                start = '_m';
            } else if (name.startsWith('gm') || name.includes(';')) {
                matched = true;
                separator = ';';
                start = 'gm';
            }
        }

        if (matched) {
            const first = name.split(separator)[0];
            if (first.startsWith(start) && !fields.includes(first)) {
                fields.push(first);
            }
        }
    }

    return { fields, matched };
}

function parsePrefabFields(text) {
    const names = orderedRectNames(parsePrefabText(text));
    return extractFields(names);
}

module.exports = {
    parsePrefabFields,
    // 便于单独测试
    parsePrefabText,
    orderedRectNames,
    extractFields,
};
