# Workstream: local-remote-suppression

- Agent identity: `local-remote-impl | DeepSeek Harness | D:\Projects\GitHub\dsh-notifier`
- Agent: `local-remote-impl`
- Branch: `codex/desktop-notify-scroll`
- Status: `done`
- Start/end: `2026-11-18 -> 2026-11-18`
- Scope: 在 Native 控制面新增本地 presence/策略 RPC，持久化「窗口焦点 / 计算机解锁 / 唤醒」远程抑制偏好；事件通知链路命中策略时保留本地 desktop、跳过远程渠道；补测试与中英文 UI。
- Plan:
  1. 新增 `src/control-surface/presence.mjs`：策略持久化（默认 focus/unlock/wake 全开）、presence 证据、主机唤醒 timer-gap 探测。
  2. `local.get` 暴露 `suppression: { policy, evidence, capabilities, active, reasons }`；新增 `local.presence.report` / `local.policy.save` RPC。
  3. `notify.mjs` 的 `notifyAll` 支持 `suppressRemote`：仅当目标里存在 desktop 时丢弃远程目标，保留本地 desktop/bell；desktop 未启用时远程发送不变。
  4. `src/index.mjs` 用 `createEventNotifier` 包住事件监听器的 notifier（不改 task-4 的 event-listener 事件过滤区域）。
  5. `client.js`：LocalView 增加远程抑制设置、当前状态与能力说明；visibility/focus 上报 presence；桌面壳用 timer gap 上报唤醒；web 只报 focus。
  6. 测试：presence/local/service/notify/client；最后全量 `npm test`。
- Owned files (actual):
  - `src/control-surface/presence.mjs`（新增）
  - `src/control-surface/local.mjs`
  - `src/control-surface/service.mjs`
  - `src/control-surface/activity.mjs`
  - `src/notify.mjs`
  - `src/index.mjs`
  - `client.js`
  - `test/local-presence.test.mjs`（新增）
  - `test/control-surface-local.test.mjs`
  - `test/notify.test.mjs`
  - `test/client-module.test.mjs`
  - `CHANGELOG.md`
- Do not touch: task-4 的 `src/config.mjs`、`src/event-listener.mjs`（本 workstream 未修改这两处；事件监听器通过 index 包装器接入）。
- Validation:
  - `npm test`：**2167 tests，2167 pass，0 fail，0 skip**（隔离临时 `DSH_HOME`，并发上限 4）。
  - 未隔离 `DSH_HOME` 时 `public.test.mjs` 会读到本机真实 `state.json` 的 `channel:desktop:outbound`，导致“多出一个 desktop”失败；这是本机状态污染，不是代码回归。隔离后同一测试通过。
  - 新测试：presence 10、local/service +6、notify +6、client +5；覆盖默认策略、证据过期、web 不能伪造 unlock/wake、desktop 未启用不抑制远程、quiet 优先、策略事务写入、RPC 信envelope/审计、UI 文案与开关。
  - `node --check`：presence/local/service/notify/index/activity/client 均通过。
- Adversarial review:
  1. **desktop 投递失败时远程已被跳过**：策略语义是“人在本机时只保留本机”，实现按目标存在性抑制；若 desktop 适配器运行时失败，用户会错过远程通知。已接受为最小切片语义，后续可在 desktop 失败后补发远程（需要防重复与重试预算）。
  2. **焦点证据不等于 OS 锁屏状态**：锁屏时 Chromium 可能仍报告 visible/focused；unlock 单独保留为能力门控证据，绝不从 focus 推断解锁。真实锁屏/唤醒行为仍需真机验证（Windows 11 26H2 仅做协议与单测，不宣称 OS 锁屏检测）。
  3. **web 不能声明 unlock/wake**：`local.presence.report` 对 `source:'web'` 的 unlock/wake 声明返回 bad-request；web 只接受可见+焦点证据。
  4. **唤醒探针误报**：主机事件循环长时间阻塞或桌面渲染层定时器被冻结都可能制造长间隙；探针 gap 90s、抑制窗 5min，属于 best-effort 本地证据，不是 OS 电源事件。
  5. **策略写入并发**：保存走 `transactDurable` 的 read-modify-write，保留其他 state key 并合并当前策略，避免两个主机各自改不同键时丢失。
  6. **默认开启的影响面**：desktop 已启用且 Native 客户端上报焦点时，远程渠道默认被跳过（用户明确要求默认开启）。desktop 未启用/本次路由未命中 desktop 时远程发送逐字节不变，有回归钉。
  7. **多客户端 last-writer-wins**：presence 是单进程内存态；同时打开多个 DSH 页面时后上报者覆盖先上报者。事件抑制读取的是同一进程状态，行为一致。
  8. **范围**：只覆盖 event-listener 自动事件通知（turn/approval/agent error/status）；手动 `notify` 工具、测试通知与晨报不经过包装器，行为不变。
- Handoff:
  - 实现完成并全量回归通过；commit 见 `git log --oneline -1`（本 workstream 收口提交）。
  - 遗留真机门：OS 锁屏/解锁证据在 DSH Desktop 渲染层没有可用宿主桥，UI 已明示 unlock 暂不生效；如果后续 DSH 暴露 session/power bridge，只需让客户端声明 `capabilities.unlock` 并上报 `unlocked`，服务端策略无需改动。
  - 建议发布前在 Windows/Linux 桌面真机验证：焦点切换立即恢复远程发送、desktop 关闭时远程照常、唤醒后 5 分钟窗口、面板中英文文案与状态行。
