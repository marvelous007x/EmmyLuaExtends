# pfb 字段补全

> **⚠️ 只适用于当前这个项目。**
> 该功能依赖本项目约定的 `--pfb:` 写法、`class(...)` 类声明、`LuaFields.GenerateLuaFields` 的节点命名规则和 prefab 目录结构。
> **其他项目不要启用**；不需要时直接删除 `pfb/` 目录即可（见文末）。

在 Lua 源码的 `---@class` 下方写一行 `--pfb: <path>`，`self.` 补全里会出现对应 prefab 的字段。

```lua
---@class DressingRoomWindowA
--pfb: IllustrationsA/DressingRoomWindow
local DressingRoomWindowA = class("DressingRoomWindowA", LuaClass.LuaWindowBase)
```

- `path` 是 `Assets/GameResources/UI/<path>.prefab` 里的 `<path>`，不带目录前缀和 `.prefab`。
- 解析规则与 `LuaFields.GenerateLuaFields(GameObject go)` 一致，只取 `fields`，忽略 `functions`。
- 不处理嵌套 prefab（`PrefabInstance` 内的节点不会出现在结果里）。
- 只缓存当前激活的 Lua 文件；切换文件时替换，关闭文件时清除。
- prefab 修改后，下次补全按 mtime 自动重新解析，不需要手动同步。

## 配置

prefab 根目录写在 workspace 的 `.vscode/emmylua-extends.json`，不使用 `settings.json`：

```json
{
    "enabled": true,
    "prefabRoot": "../GameClient/Assets/GameResources/UI"
}
```

- `enabled` 为 `false` 时关闭该功能，默认开启。
- 相对路径按 workspace 目录解析，也可以写绝对路径。
- 没有该文件时使用默认值 `../GameClient/Assets/GameResources/UI`。
- 改完立即生效，不需要重载窗口。

## 删除该功能

1. 删除整个 `pfb/` 目录。
2. 删除 `extension.js` 里 `pfbFeature` 的 `require`、`activate`、`deactivate` 三处（有 try/catch 兜底，不删也不会报错）。
3. 删除 `.vscode/emmylua-extends.json`（可选）。

## 文件

- `index.js`：VS Code 集成、缓存、补全注册。
- `annotations.js`：扫描 `---@class` / `--pfb:`，定位光标所在类。
- `prefab.js`：纯函数，prefab 文本 → fields，可用 Node 单独测试。
