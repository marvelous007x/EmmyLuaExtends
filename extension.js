'use strict';

// 功能性模块各自独立，删掉对应目录后这里会自动忽略：
//   source/  F12 从 _meta 转到 --source: 标出的源文件
//   pfb/     --pfb: prefab 字段补全
function loadOptional(name) {
    try {
        return require(name);
    } catch (e) {
        if (e.code !== 'MODULE_NOT_FOUND') {
            console.error('[emmylua-extends] ' + name + ' disabled:', e);
        }
        return null;
    }
}

const sourceFeature = loadOptional('./source');
const pfbFeature = loadOptional('./pfb');

function activate(context) {
    if (sourceFeature) {
        context.subscriptions.push(sourceFeature.activate());
    }
    if (pfbFeature) {
        context.subscriptions.push(pfbFeature.activate(context));
    }
}

function deactivate() {
    if (sourceFeature) {
        sourceFeature.dispose();
    }
    if (pfbFeature) {
        pfbFeature.dispose();
    }
}

module.exports = { activate, deactivate };
