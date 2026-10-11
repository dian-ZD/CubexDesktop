# CubexDesktop 插件开发指南

插件是 CubexDesktop 的本地扩展机制：一个文件夹 + 一份 `plugin.json` 清单 + 可执行脚本。AI 在对话中通过 `plugin_call` 工具调用插件声明的工具，也可以在输入框用 `/命令` 直接调用（需插件声明）。

## 快速开始

1. 打开「设置 → 插件 → 打开插件目录」，每个子文件夹就是一个插件。
2. 复制内置的 `hello` 示例改名字，或让 AI 帮你写（对话里说「帮我写个插件」即可，内置技能「写插件」会按协议生成）。
3. 回设置面板点「刷新」，启用插件。

## plugin.json 清单

```json
{
  "name": "my-plugin",
  "description": "一句话说明插件用途",
  "version": "1.0.0",
  "slash": true,
  "tools": [
    {
      "name": "convert",
      "description": "把输入文本转为大写",
      "command": "node index.js",
      "slashCommand": "upper",
      "slashTemplate": "把 {args} 转成大写",
      "parameters": {
        "type": "object",
        "properties": {
          "text": { "type": "string", "description": "要转换的文本" }
        },
        "required": ["text"]
      }
    }
  ]
}
```

### 字段说明

| 字段 | 必填 | 约束 | 说明 |
|---|---|---|---|
| `name` | ✅ | 字母/数字/`_`/`-`，1–40 | 插件名，目录内唯一 |
| `description` | — | ≤1000 字 | 插件用途；模型靠它决定何时调用 |
| `version` | — | ≤40 字 | 版本号；升级插件时递增 |
| `slash` | — | boolean，默认 false | **插件级开关**：true 时该插件才有资格出现在输入框 `/` 菜单 |
| `tools` | ✅ | 1–20 项 | 工具列表 |

### tools[] 字段说明

| 字段 | 必填 | 约束 | 说明 |
|---|---|---|---|
| `name` | ✅ | 字母/数字/`_`/`-`，1–40 | 工具名，插件内唯一 |
| `description` | ✅ | ≤1000 字 | 写清能做什么、何时用；模型靠它选择调用 |
| `command` | ✅ | ≤2000 字 | 在**插件目录**下以 shell 执行的命令，如 `node index.js`、`python main.py` |
| `parameters` | — | JSON Schema | 参数定义，推荐 `{"type":"object","properties":{...},"required":[...]}`；模型据此构造参数 |
| `slashCommand` | — | 中英文/数字/`_`/`-`，1–40 | 该工具的 `/` 别名。**插件 `slash:true` 且工具声明了 `slashCommand` 才会出现在 `/` 菜单** |
| `slashTemplate` | — | ≤2000 字 | 选中 `/` 命令后给模型的提示模板，`{args}` 代表用户补充的文字 |

> 双重门槛设计：`slash` 由插件作者决定「本插件是否参与 `/` 菜单」，`slashCommand` 决定「哪个工具、用什么名字」。两者都满足才会列出。

## 运行时调用协议

调用时在插件目录下以 shell 执行工具的 `command`，并注入环境变量：

| 环境变量 | 内容 |
|---|---|
| `CUBEX_ARGS` | 模型入参的 JSON 字符串（需 `JSON.parse`） |
| `CUBEX_TOOL` | 被调用的工具名 |
| `CUBEX_PLUGIN` | 插件名 |
| `CUBEX_PROJECT_ROOT` | 当前项目根目录绝对路径 |

**结果返回规则**：

- 标准输出 stdout → 返回给模型的结果（把有用信息打印到 stdout）
- stderr → 仅作调试，不返回给模型
- 退出码非 0 → 视为失败
- 单次调用超时 120 秒，超时进程被终止
- 输出超过约 40000 字符会被截断
- 用户可随时中止；长任务请留意终止信号（父进程被杀）

## 脚本模板（Node.js，零依赖）

```js
// index.js
const args = JSON.parse(process.env.CUBEX_ARGS || '{}')
const fail = (message) => { console.error(message); process.exit(1) }
try {
  switch (process.env.CUBEX_TOOL) {
    case 'convert': {
      if (typeof args.text !== 'string') fail('缺少 text 参数')
      console.log(args.text.toUpperCase())
      break
    }
    default: fail(`未知工具：${process.env.CUBEX_TOOL}`)
  }
} catch (error) {
  fail(`执行失败：${error instanceof Error ? error.message : String(error)}`)
}
```

多工具插件可以共用一个脚本，用 `CUBEX_TOOL` 分发（内置 `texttools` 就是这种结构）。

## 内置插件（可当范例抄）

| 插件 | 演示要点 |
|---|---|
| `hello` | 最小示例；`slash` + `slashCommand` + `slashTemplate` 完整用法 |
| `texttools` | 一个脚本服务多个工具（`CUBEX_TOOL` 分发）；参数校验与错误处理 |
| `sysinfo` | 只读系统探测（Node `os` 模块），AI 排查环境常用 |
| `croncalc` | 纯计算工具；输入校验、边界处理（一年内无匹配的提示） |

## 用户改过的插件不被升级覆盖

应用升级会刷新**内置示例插件**（如 hello 从 1.0.0 → 1.1.0），但如果你的 `plugin.json` 里写了 `"_customized": true`，应用会跳过刷新、保留你的修改。

## 安全须知

- 插件以**用户权限**运行本机命令，安装前请确认来源可信。
- 破坏性操作（删文件、改系统配置）应在插件内二次确认或输出提示，不要静默执行。
- `plugin_call` 属于敏感工具，默认需要用户批准后才执行（可在设置 → 权限调整）。
