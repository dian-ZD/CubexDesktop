# SPEC-002 Linux 适配与结构重构

> 状态：**阶段 1–3 已全部实施完成（2026-10-01，本地分阶段提交，未 push）** ｜ 创建：2026-10-01 ｜ 依据：SPEC-001 实测证据 + project-development skill
>
> 用户决策：D1=T7 隐藏入口；D2=试点迁 3 组件；D3=按序全做。提交策略：分阶段本地 commit 留痕，不 push、不开 PR。
>
> 用户指令：开发 Linux 适配；**少动原有代码**；沙箱代码解耦；设计更好的文件编排（功能分类、业务解耦、预留组件拆分文件树）；**全量状态广播 → 事件驱动改造明确暂不动**；先出方案再重构。

## 1. 目标

1. 平台差异与沙箱策略从 `tools.ts` 热路径中抽出，归入 `src/main/platform/` 与 `src/main/sandbox/`，**对外签名零变化**（`tools.ts` 的 10 个被导入符号全部原样保留）。
2. Linux 适配落地：SPEC-001 的 T1–T8（T4 并入阶段 1 实施）。
3. 建立"功能分类"的文件编排：主进程按域分目录；渲染层建立 `components/` 试点 + 预留树（只登记路径，不建空目录）。

## 2. 非目标（本轮明确不做）

- 全量状态广播改事件驱动（`publish`/`store` 机制不动）。
- `App.tsx` / `SettingsPanel.tsx` / `styles.css` 巨型文件拆分（架构线，另立 ADR）。
- `AgentRunner` 拆分、`ipc/` 目录实化（仅在 structure.md 登记为预留位）。
- Windows 行为变更：所有改动保持 win32 分支逻辑等价。

## 3. 硬约束

- **C1 签名不变**：`tools.ts` 公开导出（`runTool`/`runShellCommand`/`browseDirectory`/`readProjectFile`/`matchesCommandRule`/`makeDiff`/`resolveInside`/`toolSpecs`/各工具名集合）不移动、不改签名——`agent.ts`/`index.ts`/`extensions.ts`/3 个测试文件的 import 零修改。
- **C2 每阶段独立可回滚**：阶段内改动 ≤ 10 个文件；回滚 = 删新目录 + 还原被改文件。
- **C3 每阶段完成条件包含 `rules/structure.md` 同步**（结构描述与代码不一致视为 bug）。
- **C4 质量门**：每阶段结束跑 `typecheck + lint(0 error) + vitest + build + test:desktop` 全绿才进下一阶段。
- **C5 不新增运行时依赖**（打包工具 electron-builder 已在 devDependencies）。

## 4. 目标文件树

### 4.1 主进程（阶段 1 落地）

```text
src/main/
├── index.ts                  # 组合根（不动）
├── platform/                 # ★新增：平台差异唯一归口（全项目 process.platform 判断收敛于此）
│   ├── index.ts              # 能力探测 re-export
│   ├── shell.ts              # shell 解析与命令包装（原 tools.ts:344-353 shellCommand）
│   ├── proc.ts               # 进程树终止 killTree（原三处重复的 taskkill/SIGKILL 统一，= SPEC-001 T4）
│   └── capture.ts            # 截屏能力探测（Wayland/desktopCapturer 可用性，供 T2/T7 门控）
├── sandbox/                  # ★新增：沙箱策略层（纯函数，可单测）
│   ├── index.ts
│   ├── env.ts                # buildSandboxEnv（原 tools.ts:296-318）
│   └── guard.ts              # SANDBOX_ESCAPE + checkEscape（原 tools.ts:283-294）
├── tools.ts                  # 保留：dispatch/文件工具/makeDiff/runTool；commandTool 改为调用 platform+sandbox
├── extensions.ts             # 仅改 2 处：callPlugin 用 proc.killTree；computer 插件按 capture 能力门控
├── github.ts                 # 仅改 2 处：runGit 用 proc.killTree；repoNameFor 平台无关化（T3）
└── （其余 13 文件不动）
```

依赖方向新增规则：`platform/` 与 `sandbox/` 只依赖 `shared/schema` 类型；任何模块可依赖它们；它们不依赖 main 其它模块（防环）。

### 4.2 渲染层（阶段 3 落地，试点式）

```text
src/renderer/src/
├── components/               # ★新增：叶子组件试点（本轮只迁 3 个，import 影响面 4 行）
│   ├── Logo.tsx              # 仅 App.tsx 引用
│   ├── SkillMenu.tsx         # 仅 App.tsx 引用
│   └── Markdown.tsx          # App.tsx + RightPanel.tsx 引用（含 OpenTarget 类型）
├── （App.tsx / SettingsPanel.tsx / RightPanel.tsx / WorkflowCanvas.tsx 保持原位——
│    其内部拆分目标位置在 structure.md 登记为预留：components/sidebar/、components/composer/、
│    components/messages/、ipc/、agent/；只登记不建空目录，迁移发生时才创建）
```

## 5. 阶段计划

### 阶段 1：platform/ + sandbox/ 解耦（含 T4）｜改动 ≈6 文件 —— ✅ 完成（2026-10-01）

> 验证：typecheck 0 / lint 0 error / vitest 84 passed（新增 platform 5 + sandbox 4 用例，仅余已知 p9 失败待 T3）/ build 通过 / 桌面冒烟通过。killTree 孙进程终止在 POSIX 实测生效。

| 步骤 | 内容 |
| --- | --- |
| 1.1 | 新建 `platform/shell.ts`：迁入 `shellCommand`，签名不变；`tools.ts` 改为 import |
| 1.2 | 新建 `platform/proc.ts`：`killTree(child)` —— POSIX 用 `detached:true` 启动 + `process.kill(-pid,'SIGKILL')`；win32 保留 `taskkill /T /F`。`tools.ts` commandTool、`github.ts` runGit、`extensions.ts` callPlugin 三处统一调用（消灭"杀不干净子孙进程"） |
| 1.3 | 新建 `sandbox/env.ts` + `sandbox/guard.ts`：迁入 `buildSandboxEnv`/`SANDBOX_ESCAPE`；`commandTool` 内联判断改为 `checkEscape(command)` |
| 1.4 | 新建 `platform/capture.ts`：`desktopCaptureAvailable()` 探测（wayland 会话 + ScreenCast portal 失败史 → 本机返回 false；探测逻辑：`process.platform` + `XDG_SESSION_TYPE`，不实际调用 desktopCapturer 以免挂起） |
| 1.5 | 新增 `tests/platform.test.ts`（shell 解析、killTree 杀孙进程实证：`sh -c "sleep 30 & sleep 30"` 取消后 `pgrep sleep` 为空）+ `tests/sandbox.test.ts`（env 白名单、escape 拦截）；既有 `tests/tools.test.ts` **零修改**通过 |
| 1.6 | 同步 `rules/structure.md`（新增两目录 + 依赖规则）+ `rules/platform-support.md`（索引表更新：process.platform 判断点收敛清单） |

回滚：删 `platform/`、`sandbox/`、两个测试文件，`git checkout` 4 个被改文件。

### 阶段 2：Linux 适配落地（T1/T2/T3/T5/T6/T8 + T7=隐藏入口）｜改动 ≈8 文件 —— ✅ 完成（2026-10-01）

> 验证：vitest **85 passed / 0 failed / 2 skipped**（T3 修复后 Linux 全绿）；`electron-builder --linux AppImage deb` 产出 `Cubex-0.1.2-dev.AppImage`（195MB）与 `cubex-desktop_0.1.2-dev_amd64.deb`（119MB）；**打包态二进制冒烟通过**（`release/linux-unpacked/cubex-desktop` 输出 `smoke-ready`）。
> 注意：electron-builder 需 `ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/`（直连 GitHub 下载 electron zip 会 EOF 失败）；Linux 可执行名取 package.json `name`（cubex-desktop）。
> T2 实现说明：门控落在 `specs()` 注入 + `run()` 纵深拒绝 + `list()` enabled 三处；未改 schema/渲染层（避免 i18n 连锁），Wayland 下用户开关保持可拨但工具不会注入。

| 项 | 内容 | 验收 |
| --- | --- | --- |
| T1 | `package.json`：`build.linux`（AppImage+deb、category=Utility、icon=build/icon.png）+ 补 `author` 字段（顺带解决 electron-builder 警告）+ 脚本 `dist:linux` | `npx electron-builder --linux AppImage` 产出 `release/*.AppImage`；`--appimage-extract-and-run --version` 可执行 |
| T2 | `extensions.ts`：`specs()` 在非 Windows 或 `capture.ts` 探测失败时不注入 `computer_use`；`list()` 显示"仅 Windows 可用" | Linux 工具目录无 computer_use；设置页文案正确 |
| T3 | `github.ts` `repoNameFor`：先按 `/[\\/]/` 取尾段再清洗（不再依赖平台相关 `basename`）；`tests/p9.test.ts:153` 断言改平台无关 | Linux `vitest run` 全绿（77+2） |
| T5 | `scripts/ui-check.mjs`/`repro.mjs`：`process.env.TEMP` → `node:os` `tmpdir()` | Linux 下脚本进入 Playwright 启动阶段 |
| T6 | `secrets.ts`：Linux 下检测 `getSelectedStorageBackend()==='basic_text'` 时把警告追加到 `state.notice`（复用现有通知机制，不动 schema/UI） | 无 keyring 环境启动出现提示；读写往返正常 |
| T8 | `scripts/desktop-smoke.mjs`：超时 20s → 45s | 清缓存冷启动一次通过 |
| T7 | **按用户决策**（见 §7）：A=隐藏 screenshot / B=capturePage 截自家窗口 / C=portal Screenshot D-Bus 直连 | 按所选路线验收 |

### 阶段 3：渲染层试点迁移 + 预留登记 ｜改动 ≈6 文件 —— ✅ 完成（2026-10-01）

> 验证：typecheck 0 / lint 0 error / vitest 85 passed / build 通过 / 桌面冒烟通过。`git mv` 保留文件历史。
> 注：AppImage/deb 产物基于迁移前的 out/ 打包（验证的是 T1 打包链路）；迁移后代码已由开发态冒烟覆盖，如需交付产物应重新 `dist:linux`。

3.1 `Logo/SkillMenu/Markdown` 移入 `components/`，更新 4 处 import（App.tsx ×3、RightPanel.tsx ×1，Markdown 内部 `./i18n`→`../i18n`）。
3.2 `rules/structure.md` 登记预留路径与"迁移发生时才建目录"规则。
3.3 质量门全绿 + 冒烟通过（渲染层改动必须过 `test:desktop`）。

## 6. 整体验收

```bash
npm run typecheck && npm run lint && npm test && npm run build && npm run test:desktop
npx electron-builder --linux AppImage        # 阶段 2 后
```

- Linux：质量门全绿（含 vitest **0 failed**——T3 修复后基线升格为 79 passed 口径）；AppImage 可产出。
- Windows：所有 win32 分支代码路径等价（`killTree` 保留 taskkill、`computer_use` 注入条件在 win32 不变）；**未验证项**：本机无 Windows，NSIS 打包与 computer_use 需在 Windows 回归。
- 报告按四态（已实现/已验证/未实现/未验证）区分。

## 7. 待用户决策

- **D1（T7 截图路线）**：A 非 Windows 隐藏 screenshot（最小、诚实）；B `capturePage` 截自家窗口（能跑但语义不同，模型会误以为截全屏）；C portal `Screenshot.Screenshot` D-Bus 直连（真截屏，需处理授权弹窗时序，工作量最大）。**推荐 A**，C 留作后续增强。
- **D2（阶段 3 范围）**：按 §5 试点迁 3 个叶子组件；或本阶段只登记预留、零迁移。
- **D3（实施授权）**：确认后按 阶段1→2→3 顺序执行，每阶段完成即报告；或指定只做其中某几个阶段。

## 8. 风险与缓解

| 风险 | 缓解 |
| --- | --- |
| `detached` 进程组改动导致 Windows 行为漂移 | win32 分支不加 detached，仅走原 taskkill；proc.test 双平台分支各自断言 |
| T3 修改 repoNameFor 影响真实推送命名 | 清洗规则不变，仅路径切分平台无关化；p9 测试覆盖 `owner/name` 与中文目录 |
| 迁移 Markdown 破坏 worker/HMR | Markdown 无 worker 依赖；迁移后 build + 冒烟 + 手动 UI 检查（ui-check 脚本 T5 修复后可用） |
| structure.md 与代码漂移 | C3 硬约束：每阶段完成条件含同步 |
| AppImage 在本机无 FUSE 无法挂载运行 | 验收用 `--appimage-extract-and-run`；失败只报"产物已构建、运行验证受限" |

## 9. 停止条件

- 任一阶段质量门无法转绿且 30 分钟内无解 → 回滚该阶段，带证据上报。
- 发现 `tools.ts` 公开签名必须变更才能解耦 → 停下重新征求用户意见（违反 C1）。
