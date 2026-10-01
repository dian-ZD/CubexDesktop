# SPEC-001 Linux 兼容性

> 状态：**草案（待用户 Review）** ｜ 创建：2026-10-01 ｜ 流程依据：project-development skill 阶段 A–C
>
> 本文件是"方案 + 验收标准"，不记录长过程日志。规则与基线见 `rules/quality-gates.md`、`rules/platform-support.md`。

## 1. 背景

项目发布目标是 Windows（NSIS）。在 Linux（原生 GNOME / Wayland 会话）上完成一次完整接手调查后，确认**开发链路可用、发布链路缺失、且有 4 处会在 Linux 上确定性出错**。以下为实测证据，全部在 `2026-10-01` / Node v26.8.2 / npm 11.19.1 / Electron 44.4.3 / Linux Wayland 环境执行。

| 证据项 | 命令 | 实测结果 |
| --- | --- | --- |
| 类型检查 | `tsc --noEmit` | 退出码 0 |
| 静态检查 | `eslint .` | 0 error / 7 warning |
| 构建 | `electron-vite build` | 成功，`out/` 三端产出 |
| 单元测试 | `vitest run` | **76 passed / 1 failed / 2 skipped**；失败 `tests/p9.test.ts:153` |
| 桌面冒烟（首次） | `npm run test:desktop` | **超时**（20 秒内未就绪） |
| 桌面冒烟（再次） | `npm run test:desktop` | 通过：`桌面冒烟通过：窗口已创建并正常退出` |
| 冷启动日志 | `CUBEX_SMOKE=1 ELECTRON_ENABLE_LOGGING=1 node_modules/.bin/electron .` | `[cubex] smoke-ready`，0.5 秒内就绪 |
| 运行时后端 | 同上 | 走**原生 Wayland**（`ui/ozone/platform/wayland/*`），非 XWayland |
| 合成器能力 | 同上 | `zcr_alpha_compositing_v1` 缺失（KWin 专属扩展）→ 后经运行时实测：透明窗口正常，此警告无害 |
| 桌面门户 | 同上 | `Failed to register with org.freedesktop.host.portal.Registry` → 后经实测：与截图故障同源（见下方 desktopCapturer 两行） |
| 证书库 | 同上 | `ERROR:crypto/nss_util.cc:377 After loading Root Certs, loaded==false: NSS error code: -8018` |
| 依赖安装 | `npm ci` | 6 分钟；**Electron 二进制未落地**，需手动 `node node_modules/electron/install.js` |
| 透明窗口（GNOME Wayland） | /tmp 测试脚本 `capturePage` | **正常**：RGBA，角点 alpha=0；缩放 1.25 生效 |
| desktopCapturer（Wayland） | 同上 `getSources(screen)` | **失败**：`ScreenCastPortal failed: 3`，无授权弹窗 |
| desktopCapturer（强制 x11） | 同上 `--ozone-platform=x11` | **挂起**：>15 秒无返回 |

## 2. 目标

1. Linux 上"可开发 + 可跑 + 可验证"闭环成立：质量门全绿、冒烟稳定、UI 脚本可用。
2. Linux 上能产出可分发的安装产物（是否对外发布由用户另定）。
3. 平台差异有明确入口（报错 / 降级 / 隐藏），不留给模型和用户"猜"。
4. 不改动 Windows 既有行为与发布流程。

## 3. 非目标

- 不重构架构（状态广播、巨型组件、`AgentRunner` 拆分是另一条线，另立 ADR）。
- 不为 Linux 引入新的系统依赖或第三方工具（如 xdotool / ydotool），除非用户确认。
- 不做 AppImage/deb 的签名、自动更新、CI 发布流水线。
- 不处理 macOS。

## 4. 约束

- `dist` 现有语义必须保留（用户 Windows 发布依赖它），新能力以新增脚本提供。
- 涉及用户可见行为变化（工具是否出现、窗口形态）必须先经用户确认。
- 每项改动独立可回滚（单文件粒度）。
- 未获明确指令不 commit / push。

## 5. 候选方案（需要用户拍板的两个点）

**P-1 测试与仓库名推断的修法**（对应 T3）

- 方案 A（推荐）：实现侧显式按 `/[\\/]/` 切分路径，`repoNameFor` 不再依赖平台相关的 `basename()`；测试改用平台无关路径构造。收益：行为跨平台一致；成本：需覆盖 GitHub 推送的仓库名用例。
- 方案 B：只改测试断言，实现不动。收益：改动最小；成本：把平台差异留在实现里，将来仍会踩。

**P-2 Wayland 窗口形态**（对应 T7，高影响，未确认前不开工）

- 方案 A（推荐）：运行时探测 —— 透明能力不可用（合成器不支持 alpha）时回退不透明背景；原生 Wayland 下自定义最大化降级为 `win.maximize()`（Wayland 不支持 `setBounds`）。
- 方案 B：强制 `--ozone-platform=x11`（走 XWayland）统一行为，代价是放弃原生 Wayland 的缩放/输入体验。
- 方案 C：只加文档说明，不改代码。

## 6. 风险

| 风险 | 影响 | 应对 |
| --- | --- | --- |
| 改动 `specs()` 工具目录影响 Windows | 高 | T2 加平台条件，Windows 分支必须走原路径；无 Windows 环境时标注"未验证" |
| 子进程组 kill 改动引入孤儿或误杀 | 中 | 只在 POSIX 用 `detached + kill(-pid)`，Windows 保留 `taskkill /T`；验收用残留进程检查 |
| 打包配置改动破坏现有 NSIS 流程 | 中 | `dist` 不动，新增 `dist:linux`；产物不存在不得宣称完成 |
| 环境差异（NSS 证书、portal）判定错误 | 中 | 本机不能定因的项一律标"待核"，不做结论 |

## 7. 任务拆解

> 每项含改动点、验收命令、回滚方式。P0 = Linux 上确定性错误；P1 = 功能缺口；P2 = 平台行为差异；P3 = 体验。

**T1（P0）Linux 打包配置**
改动点：`package.json` 增 `build.linux`（`target: AppImage + deb`、`category`、`icon` 指向 PNG 目录），新增脚本 `dist:linux`；`dist` 保持 `--win nsis`。
验收：在 Linux 执行 `npx electron-builder --linux AppImage` → `release/` 产出可执行产物，且应用能启动到主界面。
回滚：还原 `package.json`。

**T2（P1）`computer_use` 平台门控**
改动点：`src/main/extensions.ts` —— 工具规格按平台过滤（非 win32 不注入），插件列表页对 Linux 显示"仅 Windows 可用"。
验收：Linux 下模型工具目录不含 `computer_use`，设置页文案正确；Windows 分支代码路径未改（回归待 Windows 环境）。
回滚：还原 `src/main/extensions.ts`。

**T3（P0）测试在 Linux 必失败**
改动点：`src/main/github.ts` `repoNameFor` 路径切分 + `tests/p9.test.ts` 断言平台无关化（方案 P-1）。
验收：Linux `npx vitest run` 全绿，Windows 不回归。
回滚：还原两个文件。

**T4（P1）子进程组杀不彻底**
改动点：`src/main/tools.ts`（`commandTool`）、`src/main/github.ts`（`runGit`）、`src/main/extensions.ts`（插件调用）统一 kill 策略：POSIX `detached + process.kill(-pid, 'SIGKILL')`，Windows 保持 `taskkill /PID /T /F`。
验收：启动一个长命令（如 `npm run dev`），触发超时/取消后 `pgrep -f` 确认无残留子进程。
回滚：还原对应文件。

**T5（P1）UI 脚本在 Linux 不可用**
改动点：`scripts/ui-check.mjs`、`scripts/repro.mjs` 用 `os.tmpdir()` 取代 `process.env.TEMP`。
验收：Linux 下脚本能进入 Playwright 启动阶段（不因缺 `TEMP` 抛错）。
回滚：还原脚本。

**T6（P2）凭据存储的 Linux 语义**
改动点：`src/main/secrets.ts` —— 写入/读取两侧的加密判断保持一致；Linux 下用 `safeStorage.getSelectedStorageBackend()` 检测 `basic_text` 并在设置页提示"当前系统无可用密钥环，凭据保护较弱"。
验收：在无 keyring 环境（或 `--password-store=basic`）下能给出提示，且读写往返不出现乱码。
回滚：还原 `src/main/secrets.ts`。

**T7（P2→P1，需用户确认）Wayland 窗口与截图**
运行时实测更新（2026-10-01，原生 GNOME Wayland）：
- **透明/圆角窗口：正常**。`transparent:true` 窗口 `capturePage` 输出 RGBA，角点 alpha=0、中心 alpha=255（`zcr_alpha_compositing_v1` 缺失仅影响 KWin 特效，不影响标准 alpha 通道）。缩放系数 1.25（500px → 625px）工作正常。
- **`desktopCapturer`：本机不可用（确定性故障）**。Wayland 原生路径 WebRTC 报 `ScreenCastPortal failed: 3` + `Failed to request the session subscription`（portal 无活动 Request 对象，授权对话框从未弹出）；强制 `--ozone-platform=x11` 则 15 秒以上挂起。即 `computer_use` 的 screenshot 动作在 Linux 上必然失败或挂死。
改动点（据此调整）：
1. `computer_use` screenshot 在 Linux 需要替代路径：优先 `capturePage`（已证实可用，但只能截自家窗口，全屏需另评估 portal `Screenshot.Screenshot` D-Bus 直连或提示用户装 `grim`）；或按 T2 直接隐藏该动作。
2. 原生 Wayland 下 `setBounds` 自定义最大化仍待实测（Wayland 协议不支持客户端定位/尺寸，可能静默失效）——需启动主窗口验证最大化/还原行为。
验收：Linux 下 screenshot 动作要么给出明确降级结果，要么入口隐藏；主窗口最大化/还原在 GNOME Wayland 无卡死、无黑屏。
回滚：还原 `src/main/extensions.ts` / `src/main/index.ts`。

**T8（P3）冒烟冷启动阈值**
改动点：`scripts/desktop-smoke.mjs` 超时 20s → 45s（或在首次运行缺缓存时放宽）。
验收：清空缓存后首次运行即通过。
回滚：还原脚本。

## 8. 验收标准（整体）

- Linux：`npm run typecheck`、`npm run lint`（0 error）、`npm test`（全绿）、`npm run build`、`npm run test:desktop` 全部通过，且冒烟首次运行即通过。
- Linux：`dist:linux` 产出产物并能启动到主界面。
- Windows：`npm run dist` 仍产出 NSIS 安装包，冒烟与工具目录行为不变（**本机无法验证，需在 Windows 环境回归**）。
- 每一项改动都在报告中给出：命令、真实输出、是否未验证。

## 9. 验证命令

```bash
npm run typecheck && npm run lint && npm test
npm run build && npm run test:desktop
npx electron-builder --linux AppImage
git status --short   # 确认未提交、未误触其它文件
```

## 10. 停止 / 回滚条件

- 任一改动使 Windows 打包或冒烟回归 → 立即回滚该文件，转人工确认。
- T7 涉及产品形态 → 未经用户确认不开工。
- 打包产物无法启动 → 回滚 `package.json`，不得带着不可用配置前进。
- 出现 NSS 证书、Wayland portal 等环境级问题且无法在本机定因 → 标"待核"，不写入结论。

## 11. 未验证 / 待核事项

- Windows 侧回归（本机无 Windows 环境）。
- 真实 Linux 发行版（非本机）上的打包与安装。
- `NSS error code: -8018` 对渲染层 HTTPS（预览 webview）是否有实际影响。
- ~~Wayland 门户缺失时 `desktopCapturer` 的具体表现~~ **已核实（2026-10-01）**：本机确定性故障（ScreenCast portal error 3 / X11 挂起），见 T7。
- ~~透明窗口在 GNOME Wayland 的表现~~ **已核实（2026-10-01）**：正常（RGBA alpha 生效），见 T7。
- 原生 Wayland 下 `setBounds` 自定义最大化的实际行为（待启动主窗口实测）。
- 首次冷启动超时的根因（缓存未建立 / GPU 初始化 / 二进制首次加载，未区分）。