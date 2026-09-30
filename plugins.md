# CubexDesktop 插件开发指南

CubexDesktop 支持通过本地插件扩展 AI 智能体的能力。插件是放在插件目录下的一个文件夹，内含一个 `plugin.json` 清单和可执行脚本。AI 在对话中会通过统一的 `plugin_call` 工具调用你声明的工具。

本文档覆盖：插件目录与生命周期、`plugin.json` 清单格式、运行时调用协议、可用的内置扩展接口列表、以及 Work 模式模块节点的扩展方式。

---

## 1. 快速开始

1. 打开「设置 → 插件 → 打开插件目录」，进入插件根目录（位于系统的 `userData/plugins`）。
2. 新建一个文件夹，例如 `my-plugin/`。
3. 在里面放两个文件：`plugin.json`（清单）和你的可执行脚本（如 `index.js`）。
4. 回到设置面板点「刷新」，插件即被加载；在插件列表里可启用/停用。
5. 在对话里让 AI 使用它——AI 会自动看到你声明的工具并按需调用。

最小示例（内置的 `hello` 插件即是模板）：

`plugin.json`
```json
{
  "name": "hello",
  "description": "示例插件：回显参数并返回当前时间。",
  "version": "1.0.0",
  "tools": [
    {
      "name": "echo",
      "description": "回显传入的 text 参数",
      "command": "node index.js",
      "parameters": {
        "type": "object",
        "properties": { "text": { "type": "string", "description": "要回显的文本" } },
        "required": ["text"]
      }
    }
  ]
}
```

`index.js`
```js
const args = JSON.parse(process.env.CUBEX_ARGS || '{}')
console.log(`[${process.env.CUBEX_TOOL}] ${args.text ?? ''} @ ${new Date().toLocaleString('zh-CN')}`)
```

---

## 2. plugin.json 清单格式

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `name` | string | 是 | 插件名，只能包含字母、数字、`_`、`-`，长度 1–40。目录内唯一 |
| `description` | string | 否 | 插件说明，最长 1000 字符 |
| `version` | string | 否 | 版本号，最长 40 字符 |
| `tools` | array | 是 | 工具列表，1–20 个 |

每个 `tools[]` 项（工具）：

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `name` | string | 是 | 工具名，字母/数字/`_`/`-`，长度 1–40 |
| `description` | string | 是 | 工具用途说明（会展示给模型，写清楚它能做什么、何时用），最长 1000 |
| `command` | string | 是 | 调用该工具时执行的命令，最长 2000。以 shell 方式在插件目录下执行 |
| `parameters` | object | 否 | JSON Schema 形式的参数描述，供模型生成入参。推荐 `{ "type": "object", "properties": {...}, "required": [...] }` |

---

## 3. 运行时调用协议

当模型决定调用你的某个工具时，Cubex 会在**插件所在目录**下以 shell 方式执行该工具的 `command`，并注入以下环境变量：

| 环境变量 | 说明 |
| --- | --- |
| `CUBEX_ARGS` | 模型给出的参数，JSON 字符串。用 `JSON.parse` 解析 |
| `CUBEX_TOOL` | 被调用的工具名（`tools[].name`） |
| `CUBEX_PROJECT_ROOT` | 当前项目的根目录绝对路径 |

约定：

- **标准输出（stdout）即返回给模型的结果**，请把有用信息打印到 stdout。
- 标准错误（stderr）用于调试信息，不作为结果。
- 进程**退出码非 0** 视为调用失败，错误信息会回传给模型。
- 单次调用**超时时间为 120 秒**，超时会被中止。
- 输出超过约 40,000 字符会被截断。
- 用户可随时中止运行，你的进程会收到终止信号，请妥善处理。

安全提示：插件以你的用户权限运行本机命令，请只安装信任来源的插件。破坏性操作应交由 AI 的审批流程或在插件内自行确认。

---

## 4. 内置扩展工具接口一览

除用户插件外，Cubex 内置了一批可在「设置 → 插件」中开关的能力，它们通过同一套工具机制暴露给模型：

| 工具名 | 能力 | 开关 / 前置 |
| --- | --- | --- |
| `plugin_call` | 调用你安装的用户插件工具（聚合入口） | 安装并启用对应插件 |
| `mcp_call` | 调用已接入的 MCP 服务器提供的工具 | 在设置中接入并启用 MCP 服务器 |
| `browser_open` | 打开网页并抓取标题/正文/链接 | 插件设置里的「浏览器」开关 |
| `web_search` | 联网搜索并返回结果摘要 | 插件设置里的「搜索」开关 |
| `computer_use` | 操控电脑（截图/打开/输入/按键/点击） | 插件设置里的「电脑操控」开关，且每次调用需用户批准 |
| `github_push` | 提交并推送到 GitHub 仓库 | 配置 GitHub Token |

`browser_open`、`computer_use` 等敏感工具会在界面顶部显示操控横幅，并可用 Esc 结束操控。

---

## 5. MCP 服务器

如果你的能力更适合以服务形式提供（访问外部服务、数据库、专用 API），可以实现一个 [MCP](https://modelcontextprotocol.io) 服务器，在「设置 → MCP」中接入。模型会通过 `mcp_call` 调用，`server` 与 `tool` 取自 MCP 工具目录。MCP 适合长期运行、需要状态或鉴权的场景；本地一次性命令则更适合用上面的插件协议。

---

## 6. 扩展 Work 模式模块（节点类型）

Work 模式的画布由「节点（模块）」编排，每种节点对应一类动作。节点类型定义在：

- 枚举：`src/shared/schema.ts` 的 `workflowNodeKinds`
- 展示元数据（标签/图标/说明）：`src/renderer/src/WorkflowCanvas.tsx` 的 `kindMeta`

现有节点类型包括：`task`（执行）、`check`（检查）、`review`（审阅）、`note`（备注）、`computer`（电脑操控）、`browser`（浏览器操控）、`launch`（打开应用）、`command`（命令执行）、`search`（搜索定位）、`file`（文件读写）、`git`（Git 提交）、`plugin`（插件调用）、`mcp`（MCP 调用）、`wait`（等待确认）、`ask`（询问用户）。

其中 `plugin` 节点与 `mcp` 节点让你**无需改动核心代码**即可把插件 / MCP 能力编排进工作流：在节点指令里描述要调用的插件工具与参数，运行时会交给对应的 `plugin_call` / `mcp_call`。

若要新增一种内置节点类型（需要改动源码）：

1. 在 `src/shared/schema.ts` 的 `workflowNodeKinds` 增加类型字面量。
2. 在 `src/renderer/src/WorkflowCanvas.tsx` 的 `kindMeta` 增加 `{ label, icon, hint }`。
3. 在主进程工作流执行逻辑中处理该类型对应的动作。

---

## 7. 常见问题

- **插件没出现在列表里？** 确认目录里有合法的 `plugin.json`，然后在设置面板点「刷新」。清单校验失败会被跳过。
- **调用没有返回？** 确认结果打印到了 stdout，且进程以退出码 0 结束、未超过 120 秒。
- **参数拿不到？** 参数在 `CUBEX_ARGS` 环境变量里，是 JSON 字符串，需要自行 `JSON.parse`。
- **想用其它语言写插件？** 可以，只要 `command` 能在插件目录下运行即可（Python、Go、可执行文件等均可），遵守上面的输入/输出协议。
