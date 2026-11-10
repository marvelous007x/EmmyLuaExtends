# EmmyLua Extends

配合 [`tangzx.emmylua`](https://marketplace.visualstudio.com/items?itemName=tangzx.emmylua) 使用的增强扩展，提供两项功能：

1. **F12 源文件跳转**：定义落在 `_meta` 注解里时，自动跳到 `--source:` 标注的源文件。
2. **pfb 字段与成员补全**：根据 prefab 生成 `self.` 字段，并按字段名推断组件类型、补全成员。仅适用于本项目的约定，其他项目不要启用。

扩展不能脱离 EmmyLua 单独工作：`.lua` 语言识别和原生定义结果都由 EmmyLua 提供。

## F12 源文件跳转

### meta 文件格式

文件级（适合没有 `---@class` 的全局函数）：

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

`--source:` 相对工作区根目录。查找时先取定义行所属 `---@class` 块上方的 `--source:`，没有则回退到文件级。

### 行为

- 仅在 `editorLangId == lua` 时接管 `F12`；`Shift+F12`、`Alt+F12` 保持原生。
- 定义不在 `_meta` 目录时按原生逻辑处理（单个结果直接打开，多个走原生 peek）。
- 定义在 `_meta` 里但找不到源文件、或源码中匹配不到符号时，回退到原生结果，不会乱跳。
- 支持的源文件写法：`function X:Name(...)`、`function X.Name(...)`、`X.Name = function`、`X["Name"] = function`、`function Name(...)`、`Name = function`；`---@field` 按 `self.Name =` 匹配；类/变量按 `Name =` 匹配（允许前置 `local`）。
- meta 解析结果按文件缓存，改动或关闭文件时失效。

## pfb 字段补全（仅当前项目）

在 `---@class` 下方加一行 `--pfb: <path>`，`self.` 补全里就会出现对应 prefab 的字段。

```lua
---@class DressingRoomWindowA
--pfb: IllustrationsA/DressingRoomWindow
local DressingRoomWindowA = class("DressingRoomWindowA", LuaClass.LuaWindowBase)
```

- `pfb:` 前面的 `-` 和空格数量不限：`--pfb:`、`---pfb:`、`-- pfb:` 都能识别。
- `path` 支持两种写法，均可带 `.prefab` 后缀：
  - 相对 `prefabRoot`：`IllustrationsA/DressingRoomWindow`
  - Unity 资源路径：`Assets/GameResources/UI/IllustrationsA/DressingRoomWindow.prefab`
- 解析规则与 `LuaFields.GenerateLuaFields(GameObject go)` 一致，只取 `fields`，忽略 `functions`。
- 不处理嵌套 prefab（`PrefabInstance` 内的节点不会出现在结果里）。
- prefab 文件不存在时弹错误提示，同时写入输出面板。
- 补全项右侧显示推断出的组件类型，推断不出时显示 prefab 路径。
- 只缓存当前激活的文件；prefab 修改后按 mtime 重新解析。

### 字段类型推断

按 `LuaGo:BindComponent` 的命名规则：先去掉绑定前缀（`gm` / `_m` / `m`），再按关键字匹配。

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

### 成员补全

对任意实例都生效，不限于 `self`，字段也不必真的挂在该实例上：

```lua
local t = {}
t.mImgStar10.          -- Image 的 sprite 等成员
t.mPfbGate.transform.  -- Transform 的 position 等成员
t.mGO:                 -- RectTransform 的方法，含 SetLocalPosition
```

- `.` 和 `:` 都能触发，接收者可以是 table、userdata 等任意能带 `.` 的表达式。
- 从链路里第一个能推断出类型的段开始逐级解析，因此 `t.mTextForm.transform.position.` 这类多级访问也能提示。
- 成员来自 `<metaDirName>` 下的 `---@class` / `---@field`（含父类）；`fun(...)` 显示方法图标，类型显示在候选右侧。
- meta 里没有定义的类型（如 `UINumberEffect`、`SuperScrollView.LoopListView2`）不给成员补全；字段名匹配不到关键字也不补全。
- `self` 上显式写了 `---@field` 的字段交给 EmmyLua，本扩展不重复补全。
- meta 索引按文件 mtime/size 缓存，注解改动后自动重建。

## 配置

扩展没有 VS Code 配置项，所有设置写在 workspace 的 `.vscode/emmylua-extends.json`：

```json
{
    "enabled": true,
    "metaDirName": "_meta",
    "unityProjectRoot": "../GameClient",
    "prefabRoot": "Assets/GameResources/UI"
}
```

| 字段 | 说明 |
| --- | --- |
| `enabled` | `false` 时关闭扩展，默认 `true` |
| `metaDirName` | meta 注解目录名，默认 `_meta` |
| `unityProjectRoot` | Unity 工程目录，相对 workspace 或绝对路径 |
| `prefabRoot` | prefab 根目录；配置了 `unityProjectRoot` 时相对它解析 |

- `prefabRoot` 默认 `../GameClient/Assets/GameResources/UI`。
- 没写 `unityProjectRoot` 时，`Assets/...` 形式的路径会从 `prefabRoot` 的 `Assets` 段反推 Unity 工程根。
- 相对路径按 workspace 解析，也可以写绝对路径；改完立即生效。

## 删除 pfb 功能

1. 删除整个 `pfb/` 目录。
2. 删除 `extension.js` 里 `pfbFeature` 的 `require`、`activate`、`deactivate`（有 try/catch 兜底，不删也不报错）。
3. 删除 `.vscode/emmylua-extends.json`（可选）。

## 文件

- `pfb/index.js`：VS Code 集成、缓存、补全注册。
- `pfb/annotations.js`：扫描 `---@class` / `--pfb:`，定位光标所在类。
- `pfb/prefab.js`：纯函数，prefab 文本 → fields。
- `pfb/metaTypes.js`：纯函数，字段名 → 组件类型，并建立 meta 成员索引。
- `source/index.js`：F12 转跳与回退逻辑。
- `source/meta.js`：meta 文件解析与源码符号匹配。
