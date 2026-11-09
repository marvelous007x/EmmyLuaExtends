# EmmyLua Extends

配合 `tangzx.emmylua` 使用的轻量扩展：Lua 文件里按 F12 时，如果定义落在 `_meta` 注解文件里，自动转跳到注解中 `--source:` 标注的源文件，并定位到对应的函数/字段/变量声明行。

## meta 文件格式

文件级（适合没有 `---@class` 的全局函数模块）：

```lua
---@meta
--source: Global/GlobalFunctions.lua

function Log(...) end
```

类级（优先于文件级）：

```lua
---@meta

---@class ChatManager
--source: Game/Chat/ChatManager.lua
ChatManager = {}

function ChatManager:InitEmojiTask() end
```

`--source:` 的路径相对于工作区根目录。查找定义时，先取定义行所属 `---@class` 块上方的 `--source:`，没有则回退到文件级 `--source:`。

## 行为

- 仅在 `editorLangId == lua` 时接管 `F12`。
- 定义不在 `_meta` 目录时，按正常定义跳转处理（单个结果直接打开，多个结果走原生 peek）。
- 定义在 `_meta` 目录、但找不到对应源文件或源码中匹配不到符号时，回退到原生行为（跳到 meta 注解）。
- 支持匹配的源文件写法：`function X:Name(...)`、`function X.Name(...)`、`X.Name = function`、`X["Name"] = function`、`function Name(...)`、`Name = function`；`---@field` 按 `self.Name =` 匹配；类/变量按 `Name =` 匹配（允许前置 `local`）。
- meta 文件解析结果按文件缓存，文件改动或关闭时失效。

## 设置

| 设置项 | 默认值 | 说明 |
| --- | --- | --- |
| `emmyluaExtends.metaDirName` | `_meta` | meta 注解目录名，按路径段匹配 |

## 注意

- 只接管 F12；`Shift+F12`（查找引用）、`Alt+F12`（peek）保持原生行为。
- 若源文件写法不在上述匹配范围内，会回退到 meta 注解，不会乱跳。
