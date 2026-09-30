# 记忆

> 最后更新时间：2026-09-30 ｜ 更新者：AI Agent（会话交接）
>
> 记录项目中长期有效的事实与本轮任务的过程细节。任务目标见 goal.md，步骤进度见 plan.md，此处不重复大段步骤说明。

## 技术栈与约定

- Electron 44.4.3 + React 19.3 + TypeScript 5.9 + electron-vite 5 + Vite 7.3 + electron-builder 26（NSIS，x64）。
- 依赖：`zod` 4、`lucide-react`、`@xenova/transformers`（本地 whisper ASR）。
- 目录：主进程 `src/main/`，预加载 `src/preload/`，渲染层 `src/renderer/src/`，共享层 `src/shared/`，图标脚本 `scripts/make-icon.mjs`。
- i18n 机制：`tr(zhText, vars)`（zh→en 词典，`registerPhrases()` 注册，中文缺失时原样回退）；词典集中在 `src/renderer/src/phrases.ts`，分多个 `Record` 对象分别注册以避免重复键冲突。
- 数据存储（Electron `userData`）：开发运行用 `name`=cubex-desktop → `Roaming\cubex-desktop`；安装版用 `productName`=Cubex → `Roaming\Cubex`。核心文件 `state.json`、`secrets.json`、`plugins/`（见 `src/main/index.ts` 第 19/20/44 行）。
- 打包标识：`appId=com.cubex.desktop`，`productName=Cubex`，NSIS `perMachine:false`、`oneClick:false`、可改安装目录。

## 关键决策

- 圆角图标合成方式：用纯 `nativeImage` BGRA 像素处理（`scripts/make-icon.mjs` 的 `roundedIcon`/`roundedAlpha`/`buildIco`），不引入 `sharp`。原因：避免新增原生依赖。时间：图标任务期间。
- 应用内圆角范围：仅「助手消息头像 + 标题栏小图标」，由用户经选择题确认；侧栏/欢迎页/引导页不加。
- 删除主题分区但保留 schema 字段：`appearance.theme/accent/background` 仍是合法设置，只是入口从「主题」页迁到「外观」页。原因：不破坏已有用户数据结构。
- 版本策略：本轮保持 0.1.1，未升 0.1.2（用户未确认）。

## 本轮改动文件清单（每项一句话）

- `scripts/make-icon.mjs` —— 重写为合成白色圆角底图标（BGRA 像素 + 多尺寸 ICO）。
- `src/renderer/src/Logo.tsx` —— 新增 `rounded` 属性，包一层白底圆角 `span`。
- `src/renderer/src/styles.css` —— 加 `.logo-rounded` 及 `:has(> .logo-rounded)` 选择器；新增 7 个字体栈 `:root[data-font-family='X']`。
- `src/renderer/src/App.tsx` —— 标题栏 `<Logo size={18} rounded />`、助手头像 `<Logo size={26} rounded />`；panelFallback 移入组件内以用 `tr`；approval/onboarding 文案接入 `tr`。
- `src/shared/schema.ts` —— `fontFamilies` 由 9 项扩到 16 项。
- `src/renderer/src/SettingsPanel.tsx` —— 全量接入 `tr`；`fontFamilyLabels` 扩到 16；Zod 错误经 `tr(issue.message)`；scheduleLabel 改内联 `tr` 模板；删除主题分区并入外观（`SectionId`/`sections`/`sectionPrefixes`/三行 Row/hint/移除 `Palette` 导入）。
- `src/renderer/src/phrases.ts` —— 新增 `morePhrases`、`settingsPhrases2` 等词条；补外观新 hint 翻译。
- `src/renderer/src/ui.tsx`、`src/renderer/src/Markdown.tsx` —— 补 `tr`（关闭提示/取消/确定/复制代码等）。
- `package.json` —— 版本 0.1.0 → 0.1.1。
- 外部修改（勿回退）：`src/main/index.ts`（createWindow 先于 buildAppIcon、MCP/scheduler 延迟 1200ms）、`src/renderer/src/speech.worker.ts`（whisper-tiny ASR 流水线）。

## 已知问题与坑

- **asar 锁定**：`npm run dist` 打包时 `release\win-unpacked\resources\app.asar` 可能被杀软/索引器锁定（非 Cubex/node 进程），导致 `Remove-Item release` 失败。绕过：结束进程 + 删 `release`/`out` 后重试；仍失败用 `npx electron-builder --win nsis "-c.directories.output=dist-out"`（`-c` 参数在 PowerShell 必须加引号）。本轮清理进程与产物后 `npm run dist` 一次成功。
- **Program Files 权限**：删除 `C:\Program Files\Cubex` 需管理员，`-Verb RunAs` 提权可能被用户取消；当前该空文件夹壳残留，不影响重装。
- **本目录非 git 仓库**：`git status` / `git log` 返回 exit 128；不要尝试 git 提交/推送。
- **lint 既有告警**：`npm run lint` 有 7 个 `react-hooks/exhaustive-deps` 关于 `tr` 的 warning（App.tsx），为既有告警、非本轮引入，0 error。

## 用户明确偏好与禁忌（尽量原样）

- 「应用内部分地方也是，但是不要全加」——圆角只加指定位置。
- 「i18n覆盖不全」「全部补全」——要求彻底覆盖。
- 「删除主题设置页并将设置项移到外观中」。
- 「删除我本地的所有在cubex中的进度我要重新安装，版本还是0.1.1重新编译安装包」。
- 全程中文回复。

## 已运行的关键命令及结果摘要

- `npm run typecheck` → exit 0。
- `npm run lint` → exit 0（7 warning，0 error）。
- 结束进程：`Get-Process -Name Cubex | Stop-Process -Force` → all stopped。
- 卸载：两处 NSIS `Uninstall Cubex.exe`（`/allusers /S`、`/currentuser /S`）→ 目录清空。
- 删除数据：`Roaming\Cubex`、`Roaming\cubex-desktop`、`Local\cubex-updater`、`Local\Programs\cubex` → deleted；`C:\Program Files\Cubex` → FAILED(Access denied)，UAC 提权被取消。
- `npm run dist` → 成功，产物 `release\Cubex Setup 0.1.1.exe`（137.83 MB，已签名 + blockmap）。

## 未解决问题 / 待确认

- 是否升版本到 0.1.2 并重打包？（待确认）
- 是否需要清掉 `C:\Program Files\Cubex` 空壳？（待确认）
- 旧版残留注册表项是否已随卸载器清除？已注册的 `Cubex 0.1.1` / `Cubex 1.2.5` 卸载后未复核注册表（待确认）。

## 临时性上下文

- 冒烟测试会把 userData 指向临时目录：`CUBEX_SMOKE=1` 时 `app.setPath('userData', temp/cubex-smoke-<pid>)`（`src/main/index.ts` 第 18 行）。
- 管理端（历史阶段）运行于 `http://127.0.0.1:4800`，管理密钥经环境变量 `CUBEX_ADMIN_KEY` 注入——**真实值不写入此处**，仅记引用位置。
