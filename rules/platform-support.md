# 平台支持与数据安全纪律

> 最后更新时间：2026-10-01 ｜ 维护者：AI Agent（project-development 初始化）
>
> 本文件记录"哪些平台算正式支持"以及"哪些操作不可逆"。已知差异与修复计划见 `specs/SPEC-001-linux-compatibility.md`。

## 平台支持边界（现行事实）

- **发布目标：Windows x64（NSIS）**。`npm run dist` = `electron-vite build && electron-builder --win nsis`（`package.json`），图标资源为 `build/icon.ico`。
- **Linux：开发可用，非发布目标**。typecheck / lint / build / 桌面冒烟均已在本机实测通过；已知差异共 8 项，登记在 SPEC-001。新增功能若引入平台相关能力，必须同时给出非 Windows 行为的说明（报错、降级或隐藏入口三选一）。
- **macOS：未支持**。无打包配置、无实测，不作为验收依据。
- 平台判断一律用 `process.platform`；路径一律用 `node:path`（`join/relative/sep`），**禁止**硬编码 `\` 或盘符。历史坑：`path.basename` 语义随平台变化，处理来路不明的路径字符串时不能假设分隔符。

## 平台相关代码索引（改动时必须连带检查）

| 关注点 | 位置 |
| --- | --- |
| Shell 选择与命令执行 | `src/main/tools.ts`（`shellCommand`、`commandTool`） |
| 子进程环境与沙箱 | `src/main/tools.ts`（`buildSandboxEnv`、`SANDBOX_ESCAPE`） |
| MCP 服务端启动 | `src/main/mcp.ts` |
| Git 推送 | `src/main/github.ts` |
| 扩展 / 插件 / 电脑操控 / 浏览器取数 | `src/main/extensions.ts` |
| 凭据存储 | `src/main/secrets.ts` |
| 窗口形态（无边框/透明/最大化） | `src/main/index.ts`（`createWindow`、`toggleMaximize`、`buildAppIcon`） |
| 打包与图标 | `package.json` `build` 段、`build/icon.*`、`scripts/make-icon.mjs` |
| 开发期脚本 | `scripts/*.mjs` |

## 数据与密钥纪律

- 用户数据目录一律走 `app.getPath('userData')`：Linux `~/.config/cubex-desktop`，Windows `%APPDATA%\cubex-desktop`。**禁止**硬编码绝对路径。
- 凭据只存 `secrets.json`（`SecretStore`，文件权限 0600，优先 safeStorage 加密）。Linux 上 safeStorage 依赖 kwallet / gnome-libsecret，无 keyring 时 Electron 退化为 `basic_text`（硬编码口令，等于未保护）——涉及凭据的改动需要显式说明该平台行为。
- 真实 API Key / Token / 管理密钥**不得**写入代码、文档、测试、日志、提交信息。文档中只写引用位置（环境变量名、设置项路径）。
- `state.json` 采用整份原子写（tmp + rename），损坏时备份为 `.corrupt` 并重置。改动持久化逻辑必须保持原子性与"损坏可恢复"。
- 文件类工具必须复用 `src/main/tools.ts` 的 `resolveInside()` 做真实路径越界校验；新增文件读写入口不得绕过。敏感文件名（`.env*`、`*.pem`、`*.key`、`id_rsa*`、`credentials*`）默认拒绝访问。
- 命令沙箱是"弱隔离"：仅正则黑名单 + 环境变量清理/代理改写，不是内核级隔离。涉及沙箱的改动不得在文档或提示词中宣称提供强隔离。

## 不可逆操作清单（执行前必须先确认）

- 删除 / 覆盖用户项目文件，`git push`，`git reset --hard`，`rm -rf`，批量重命名或移动仓库文件。
- 修改全局 npm 配置、全局环境变量、用户级目录（`~/.trae-cn`、`~/.config`）下的现有文件。
- 归档内容的清理：默认只归档不删除（归档区约定见 `agents.md`）。
- 未经用户明确指令，不得 commit / push / 建 PR（沿用 `agents.md` 禁止事项）。

## 归档与文档治理

- 现行入口：`AGENTS.md 体系 = agents.md / goal.md / plan.md / memory.md`（沿用项目现状，不另建 `AGENTS.md`）。
- 规则放 `rules/`，方案与决策放 `specs/`（`SPEC-XXX-主题.md` / `ADR-XXX-主题.md`）。
- `docs/` 与归档区（`achieve/`）**暂不建立**：等有可读资料或确需归档时再建，建立时必须在 `agents.md` 登记。
- 新增规则类文件必须在本文件或 `agents.md` 登记，避免同一规则两处维护。