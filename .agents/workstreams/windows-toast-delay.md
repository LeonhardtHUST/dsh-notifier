# Workstream: windows-toast-delay

- Agent identity: `windows-toast-delay | DSH Agent Teams worker (deepseek-flash) | Windows`
- Agent: `windows-toast-delay`
- Branch: `codex/desktop-notify-scroll`
- Status: `done`
- Start/end: `2026-11-18 -> 2026-11-18`
- Scope: 最小化 Windows 桌面通知单条可见返回延迟：去掉 WinRT Toast `Show()` 之后的固定 300ms 等待，保留失败回落与超时安全，不引入常驻 PowerShell worker。
- Plan: 读取 `src/adapters/desktop.mjs` 的脚本构建与 `runCommand` 超时路径 -> 删除 Show 后的固定睡眠并补注释 -> 更新 `test/desktop.test.mjs` 结构守卫 -> 同步 guide/CHANGELOG -> 聚焦测试 -> 全量 `npm test`。
- Owned files: `src/adapters/desktop.mjs`; `test/desktop.test.mjs`; `docs/guide.md`; `docs/guide.en.md`; `CHANGELOG.md`; 本文件。
- Do not touch: 入站/审批/提问路径、admin 监听绑定、其他适配器、发布元数据、运行中的 DSH profile。
- Validation: `node --test test/desktop.test.mjs` 36 pass / 0 fail；隔离临时 `DSH_HOME` 下 `npm test`：**2137 tests，2137 pass，0 fail，0 skip**（非隔离环境的 `public.test.mjs` 会把本机已启用的本地桌面通知算进 `delivered`，属环境既有差异，非本次改动引入）；`node --check src/adapters/desktop.mjs`、`node scripts/gen-channel-matrix.mjs --check`、`git diff --check` 均通过。
- Adversarial review: 逐项确认不改动的安全面——`Show()` 抛错仍进 catch 走 NotifyIcon 气球；气球 `ShowBalloonTip(3000)` + `Start-Sleep 3000` + `Dispose` 保留，仍在 10s `COMMAND_TIMEOUT_MS` 内；气球也失败时仍写 stderr 并 `exit 1`；非零退出码仍由 `runCommand` 映射为 API_ERROR / TIMEOUT。移除的是成功路径上的空闲等待，不是异常保护。风险：`Show()` 返回后立即退出进程，理论上存在通知尚未由系统渲染的窗口——这是任务指定的 accepted 语义，需真机观察确认。
- Handoff: 改动为 `desktop.mjs` 删除 1 行 `Start-Sleep -Milliseconds 300` 并补充注释；测试新增两处结构守卫。提交：`codex/desktop-notify-scroll` 上的 `perf(desktop): return as soon as the Windows toast is accepted`（未推送：同分支仍有其他 workstream 的在途改动，由 lead 统一整合推送）。剩余风险：真实通知在极慢机器上的渲染时序未做真机验证。
