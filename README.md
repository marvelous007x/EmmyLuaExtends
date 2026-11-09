# EmmyLua Extends

配合 `tangzx.emmylua` 使用的轻量扩展：Lua 文件里按 F12 时，如果定义落在 `_meta` 注解文件里，自动转跳到注解中 `--source:` 标注的源文件，并定位到对应的函数/字段/变量声明行。

> **⚠️ `pfb/` 字段补全是针对于个人下面某个特定项目的，不是通用的。**
> 它依赖本项目约定的 `--pfb:` 写法、`class(...)` 类声明。
> **其他项目不要启用**；不需要时直接删除 `pfb/` 目录即可（见下文）。

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

## pfb 字段补全（仅当前项目）

> **只适用于当前这个项目。** 其他项目不要启用；不需要时直接删除 `pfb/` 目录即可。

在 Lua 源码的 `---@class` 下方写一行 `--pfb: <path>`，`self.` 补全里会出现对应 prefab 的字段。

```lua
---@class DressingRoomWindowA
--pfb: IllustrationsA/DressingRoomWindow
local DressingRoomWindowA = class("DressingRoomWindowA", LuaClass.LuaWindowBase)
```

- `path` 支持两种写法，都可以带 `.prefab` 后缀：
  - 相对 prefabRoot：`IllustrationsA/DressingRoomWindow`；
  - Unity 资源路径：`Assets/GameResources/UI/IllustrationsA/DressingRoomWindow.prefab`，相对 Unity 工程根。
- 解析规则与 `LuaFields.GenerateLuaFields(GameObject go)` 一致，只取 `fields`，忽略 `functions`。
- 不处理嵌套 prefab（`PrefabInstance` 内的节点不会出现在结果里）。
- `--pfb:` 指向的 prefab 文件不存在时，会弹出错误提示，同时写入输出面板。
- 只缓存当前激活的 Lua 文件；切换文件时替换，关闭文件时清除。
- prefab 修改后，下次补全按 mtime 自动重新解析，不需要手动同步。

### 字段名与成员补全

字段类型按字段名推断，与 `LuaGo:BindComponent` 的命名规则一致：先去掉绑定前缀（`gm` / `_m` / `m`），再按关键字顺序匹配。

| 关键字 | 类型 |
| --- | --- |
| `GO` | `CS.UnityEngine.RectTransform` |
| `Pfb` | `CS.UnityEngine.GameObject` |
| `Btn` | `CS.UnityEngine.UI.Button` |
| `Toggle` | `CS.UnityEngine.UI.Toggle` |
| `Input` | `CS.UnityEngine.UI.InputField` |
| `Text` | `CS.UnityEngine.UI.Text` |
| `Number` | `UINumberEffect` |
| `Img` | `CS.UnityEngine.UI.Image` |
| `RImg` | `CS.UnityEngine.UI.RawImage` |
| `Scroll` | `CS.UnityEngine.UI.ScrollRect` |
| `Loop` | `SuperScrollView.LoopListView2` |
| `Slider` | `CS.UnityEngine.UI.Slider` |

对任意实例都生效，不限于 `self`，字段也不必真的挂在该实例上：

```lua
local t = {}
t.mImgStar10.          -- 提示 CS.UnityEngine.UI.Image 的 sprite 等成员
t.mPfbGate.transform.  -- 提示 CS.UnityEngine.Transform 的 position 等成员
```

- 触发条件是任意 `a.b.c.` / `a.b.c:` 链路，接收者可以是 table、userdata 等任意能带 `.` 的表达式。
- 链路从第一个能按字段名推断出类型的段开始，逐级查 meta 成员类型，因此 `t.mPfbX.transform.`、`t.mTextForm.transform.position.` 这类多级访问也能提示。
- 成员来自 `<metaDirName>` 下的 `---@class` / `---@field`，包括父类；`fun(...)` 类型显示为方法图标，其余为字段，`detail` 显示类型。
- meta 里没有定义的类型（如 `UINumberEffect`、`SuperScrollView.LoopListView2`）不会给出成员补全。
- 字段名匹配不到任何关键字时不做补全。
- `self` 上显式写了 `---@field` 的字段交给 EmmyLua 自己处理，本扩展不重复补全。
- meta 索引按文件 mtime/size 缓存，注解改动后自动重建。

### 配置（source 和 pfb 共用）

`metaDirName` 和 pfb 配置都写在 workspace 的 `.vscode/emmylua-extends.json`，不使用 `settings.json`：

```json
{
    "enabled": true,
    "metaDirName": "_meta",
    "unityProjectRoot": "../GameClient",
    "prefabRoot": "Assets/GameResources/UI"
}
```

- `metaDirName`：meta 注解目录名，默认 `_meta`。
- `unityProjectRoot`：Unity 工程目录，相对 workspace 或绝对路径；配置后 `prefabRoot` 相对它解析。
- `prefabRoot`：prefab 根目录。不写 `unityProjectRoot` 时按原方式相对 workspace 解析（兼容旧配置）。
- 没写 `unityProjectRoot` 时，`Assets/...` 形式的路径会从 prefabRoot 里的 `Assets` 段自动反推 Unity 工程根。
- `enabled` 为 `false` 时关闭该功能，默认开启。
- 相对路径按 workspace 目录解析，也可以写绝对路径。
- 没有该文件时使用默认值 `../GameClient/Assets/GameResources/UI`。
- 改完立即生效，不需要重载窗口。

### 删除该功能

1. 删除整个 `pfb/` 目录。
2. 删除 `extension.js` 里 `pfbFeature` 的 `require`、`activate`、`deactivate` 三处（有 try/catch 兜底，不删也不会报错）。
3. 删除 `.vscode/emmylua-extends.json`（可选）。

### 文件

- `index.js`：VS Code 集成、缓存、补全注册。
- `annotations.js`：扫描 `---@class` / `--pfb:`，定位光标所在类。
- `prefab.js`：纯函数，prefab 文本 → fields，可用 Node 单独测试。
- `metaTypes.js`：纯函数，字段名 → 组件类型，并解析 meta 注解建立成员索引。

## 设置

本扩展没有 VS Code 配置项，所有设置都在 workspace 的 `.vscode/emmylua-extends.json`，见上文「配置」。

## 注意

- 只接管 F12；`Shift+F12`（查找引用）、`Alt+F12`（peek）保持原生行为。
- 若源文件写法不在上述匹配范围内，会回退到 meta 注解，不会乱跳。
