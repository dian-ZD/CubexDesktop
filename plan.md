# 计划

> 最后更新时间：2026-09-30 ｜ 更新者：AI Agent（会话交接）
>
> 记录当前任务的拆解与进度。总目标见 goal.md，过程细节/决策见 memory.md。标记：`[ ]` 未开始 ｜ `[x]` 已完成 ｜ `[~]` 进行中。

## 当前阶段

阶段 4（清理本地进度 + 重编译 0.1.1）**已完成**；等待用户下一步指示（是否升版 0.1.2 或验证安装）。当前无进行中的编码任务。

## 步骤清单

### 步骤 1：应用图标白色圆角底 + 0.1.1 编译 —— [x]

- 目标：图标加白色圆角底（OS 层 + 应用内部分位置），并编译 0.1.1。
- 涉及文件：`scripts/make-icon.mjs`、`src/renderer/src/Logo.tsx`、`src/renderer/src/App.tsx`、`src/renderer/src/styles.css`、`build/icon.*`、`package.json`。
- 产出：白色圆角图标；仅「助手消息头像 + 标题栏小图标」用圆角 Logo；版本升 0.1.1。
- 验证：`npm run make-icon` 目视确认；electron-builder 打包成功。
- 结论：完成。首次 `npm run dist` 因 `app.asar` 被外部进程锁定失败，改用输出重定向绕过（详见 memory.md「已知问题与坑 · asar 锁定」）。

### 步骤 2：i18n 全量补全 + 字体扩充 —— [x]

- 目标：设置页等所有硬编码中文接入 `tr()`；字体 9→16。
- 涉及文件：`src/renderer/src/SettingsPanel.tsx`、`src/renderer/src/phrases.ts`、`src/shared/schema.ts`、`src/shared/schedule.ts`、`src/renderer/src/App.tsx`、`src/renderer/src/ui.tsx`、`src/renderer/src/Markdown.tsx`、`src/renderer/src/styles.css`。
- 产出：i18n 覆盖 SettingsPanel/shared/App/ui/Markdown；Zod 错误经 `tr(issue.message)`；字体 16 项（schema + CSS 栈 + 标签翻译一致）。
- 验证：typecheck exit 0；lint 0 error（7 个既有 `tr` 依赖 warning）；build exit 0。
- 结论：完成。

### 步骤 3：删除「主题」设置分区并入「外观」 —— [x]

- 目标：删除 theme 分区，主题/配色/背景三项并入 appearance。
- 涉及文件：`src/renderer/src/SettingsPanel.tsx`、`src/renderer/src/phrases.ts`。
- 具体改动：
  - `SectionId` 去掉 `'theme'`；`sections` 数组删除 theme 项；移除未使用的 `Palette` 图标导入。
  - `sectionPrefixes` 把 theme 的三个前缀并入 `appearance`，删除 theme 条目。
  - 三行 Row（key: theme/accent/background）的 `section` 由 `'theme'` 改为 `'appearance'`。
  - appearance 分区 hint 改为「主题、配色、背景、字号、密度、动效与对话显示」，并在 phrases.ts 补对应英文。
- 边界：**不删** `schema.ts` 的 `appearance.theme/accent/background` 字段。
- 验证：typecheck exit 0；lint 0 error（同上 7 warning）。
- 结论：完成。

### 步骤 4：清理本地全部进度 + 重编译 0.1.1 —— [x]

- 目标：删除本地所有 Cubex 进度数据以便重装；版本保持 0.1.1 重新打包。
- 操作与结论（命令结果摘要见 memory.md「已运行的关键命令」）：
  - 结束 4 个正在运行的 `Cubex.exe` 进程。
  - 用各自 NSIS 卸载器静默卸载：Cubex 0.1.1（perMachine，`C:\Program Files\Cubex`）与 Cubex 1.2.5（perUser，`Local\Programs\cubex`）。
  - 删除：`Roaming\Cubex`、`Roaming\cubex-desktop`、`Local\cubex-updater`、`Local\Programs\cubex`。
  - 清理旧构建产物 `release` / `dist-out` / `out`（本次无锁定）。
  - `npm run dist` 成功 → `release\Cubex Setup 0.1.1.exe`（137.83 MB，已签名，含 blockmap）。
- 遗留：`C:\Program Files\Cubex` 空文件夹壳未删（删它需管理员，UAC 提权被用户取消）。不影响重装。

## 当前进行到的精确位置 / 下一步第一件事

- 所有编码与打包步骤已完成。**下一步第一件事**：等待用户确认收货或提出新需求。
- 若用户要求升版本：编辑 `package.json` 的 `"version": "0.1.1"` → `"0.1.2"`，然后 `npm run dist` 重新打包并核对产物名。
- 若用户要求彻底清空 `C:\Program Files\Cubex` 空壳：以管理员运行 `Remove-Item "C:\Program Files\Cubex" -Recurse -Force`。

## 已知风险 / 阻塞项及应对

- **风险：electron-builder 打包时 `app.asar` 被杀软/索引器锁定**。应对：打包前先结束 Cubex 进程并删除 `release`/`out`；仍锁定时用 `npx electron-builder --win nsis "-c.directories.output=dist-out"` 输出到新目录（PowerShell 中 `-c...` 参数必须加引号）。
- **风险：Program Files 需管理员权限**。应对：`Start-Process ... -Verb RunAs`；被取消则降级为「不影响主流程」处理。

## 已被否决 / 放弃的方案

- 用 `sharp` 等第三方库合成圆角图标 → 放弃，改用纯 `nativeImage` BGRA 像素处理，避免新增依赖。
- 直接 `Remove-Item release` 解锁 asar → 无效（目录仍被占用），改为输出重定向。
