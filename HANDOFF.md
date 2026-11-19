# dsh-notifier 当前交接快照

更新时间：2026-11-19。维护 fork：`LeonhardtHUST/dsh-notifier`；npm：`@leonhardthust/dsh-notifier`。上游署名与历史发布保持不变。

## 任务状态 type:state

- `0.15.0` 已发布：[GitHub Release](https://github.com/LeonhardtHUST/dsh-notifier/releases/tag/v0.15.0)、[npm latest](https://www.npmjs.com/package/@leonhardthust/dsh-notifier/v/0.15.0)。不可变 tag `v0.15.0` 指向 `7d72ba3`，已合入维护 fork 的 `dev`/`main`。
- 插件设置显示名为「消息通知 / Notification」（`2679ad0`）。npm 包名和配置 ID 不变；未修改或重启运行中的 Desktop profile。
- 宿主要求仍是精确 `0.2.2-rc.3`；未增加运行时依赖、监听端口或鉴权方式。

| 项目 | 0.15.0 发布基线 |
| --- | --- |
| 测试 | `npm test` **2231 tests**（2230 通过，0 失败，1 跳过） |

## 发布内容 type:progress

- `cd0afb4`、`d075799`、`82862fc`：宿主 todo/goal 与待审批/提问事件；区分即时结算和 timed pending，todo 暂停/取消由快照推断。
- `834872a`、`18eaa2b`、`914a4fc`：全局浮层、标题栏安全区、会话跳转、分类设置和静音管理；修复焦点基线、启动导航竞争、键盘/静音菜单误消失和卡片就地反馈。
- `90f3212`、`8dc87b7`：原生会话操作；Linux 异步操作观察不算已接受，保留远程兜底；Windows 不写注册表/快捷方式。
- `c945d13`：统一投递与会话静音事务、认证 RPC、精确交互处理器归属。认领用于避免重复通用提醒，不代表卡片送达，不改变裁决授权。
- `d6206bf`：中英文指南、架构、运维、发布基线和变更日志更新。详细审查和验证见 `.agents/workstreams/session-notifications.md`。

## 验证与限制 type:dead-end

- [OIDC 发布工作流](https://github.com/LeonhardtHUST/dsh-notifier/actions/runs/44495546848)第 2 次验证通过：首次已发布，但注册表可见性延后；未重复发布或重打 tag。下载包的 SHA-512 符合 npm integrity、共 334 个文件，两种 locale 均可读取；SLSA provenance 对应发布提交。

- 隔离 `DSH_HOME`、hermetic 网络、并发上限 4：`npm test` 2231 项，2230 通过、0 失败、1 个既有 Windows symlink 用例跳过。release guard、渠道矩阵、Host/Client 语法与 diff 检查通过。
- 已安装 rc.3 的 `dsh-app://app` 会将 `/dsh-notifier` 的非静态路径转发至已认证 HTTP Host。该结论是宿主源码证据，不是实机交互验证。
- Windows Toast 的会话按钮打开受信 loopback Web；没有原生静音按钮。Linux 动作受 libnotify/通知服务支持约束。macOS、Windows 气球回落为纯通知。跨会话摘要、第三方不带会话的通知、测试通知无可跳转会话。

## 下一步 type:goal

- 仅在获得授权后，在单独的测试环境从 npm 安装 0.15.0；登录 DSH Desktop，制造两个会话的 todo 完成、等待审批/问卷，验证标题栏可操作、点击打开正确会话、静音一会话不影响另一会话。
- 真机验证 Windows 通知点击、Linux GNOME/KDE 通知打开/自定义静音回调；专门记录收据与能力，不从协议模拟推断设备送达。
