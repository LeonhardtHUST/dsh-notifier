# dsh-notifier knowledge base

这是人类和 agent 的导航页。每个问题尽量只指向一个权威来源；运行时真相仍是 `src/` 与 `test/`，版本真相是 `package.json`。

> 当前线：`@leonhardthust/dsh-notifier@0.15.1` 准备发布（宿主兼容迁到 DSH `0.2.2-rc.5`）；npm latest 仍是 `0.15.0`，tag `v0.15.0` 指向 `7d72ba3`。`main` 是唯一长期分支。已认证界面和系统通知动作的真机证据仍单独记录。

## 当前基线

- 当前线：**0.15.1**（未发布），把宿主声明迁到精确 `0.2.2-rc.5` 并复核 22 条 seam；npm latest 仍是 **0.15.0**（2026-11-19，GitHub Release / npm latest / OIDC provenance 已确认），纳入会话通知策略、会话静音、原生动作与可配置浮层；插件设置显示「消息通知 / Notification」。
- 已发布基线测试：`2231` 项（本地 Windows 2230 pass，0 fail，1 symlink skip；隔离 `DSH_HOME`，Node test 并发上限 4）。历史 v0.14.2 为 `2175`，v0.14.1 为 `2137`，v0.14.0 为 `2084`。
- 运行时与兼容性继续以 `src/`、`test/` 及包 manifest 为准；实现验证不等于真机验收。
- 单仓库 fork 模型：`LeonhardtHUST/dsh-notifier` 是维护和发布仓库，`main` 是唯一长期分支（开发与发布都在 main）；`THEWOLFWALKER/dsh-notifier` 是上游，自动同步只创建到 fork `main` 的审查 PR。
- Awesome DSH / dshfind 是独立目录；其版本与描述刷新不属于 npm 发布流程。
- Node.js ESM、Node `>=22`、无生产依赖、无构建步骤；28 个出站渠道，Telegram/Feishu/QQ Bot/WxPusher/WeChat iLink/DingTalk 六个入站控制通道。
- v0.12 起 DSH Native「通知与控制」是日常主控制面（Sidebar/Main + Plugins 入口）；Standalone Web 管理台只监听 `127.0.0.1`，降级为 Advanced / Recovery；YAML / CLI 是高级、自动化与 headless 入口。出站保存 Hot Apply，不重启。
- Native 与 Web/admin 的问题结算均复用 Control Core；desktop `ask_user` 没有安全宿主接口，不能声称桌面结算或双端共享。当前目标宿主为 DSH `0.2.2-rc.5`（精确 `engines.dsh`，旧 `0.2.1-*`/`0.1.7-*` 不再声明）；provider/device 级验证仍按 `docs/memory/risks.md` 单独记录。

## 阅读顺序

1. [AGENTS.md](../AGENTS.md)：边界、工作流、验证命令。
2. [memory/README.md](memory/README.md) 与 [memory/project-state.md](memory/project-state.md)：当前事实和发布门。
3. [README.md](../README.md) / [README.zh-CN.md](../README.zh-CN.md)：安装与能力概览。
4. [guide.md](guide.md)：从安装、开启管理台到个人模式、配对、测试通知和日常使用。
5. [architecture.md](architecture.md) / [architecture-roadmap.md](architecture-roadmap.md)：已实现架构与规划方向（规划不等于已发布）。
6. [OPERATIONS.md](OPERATIONS.md) / [VERSIONING.md](VERSIONING.md)：运维、验证和发布规则。
7. [protocol-preflight/](protocol-preflight/) / [security/](security/) / [compatibility-matrix.md](compatibility-matrix.md)：协议、安全与兼容性证据。
8. [HANDOFF.md](../HANDOFF.md)：当前交接快照；[CHANGELOG.md](../CHANGELOG.md)：变更历史。

## 能力与安全摘要

- 出站统一经 adapter/spec 层，通知分为 `timeSensitive`、`active`、`passive`；入站审批、会话、问题共享 Control Core、token vault、身份绑定、来源聊天校验和首达结算。
- 身份至少按 `(channel,accountId,userId)` 隔离，携带账号/聊天时精确匹配 `(channel,accountId,userId,chatId)`。未知来源、缺关键字段、错误 token、过期或异常均 fail-closed。
- QQ C2C 按钮与 GROUP 文本 fallback、QQ/WeChat iLink/DingTalk 图片 envelope 属于 contract-tested；文件/媒体和 provider payload、重连、回调 ACK 仍是 `declared` 或未验证，禁止写成真机支持。
- `ctx.notifier` facade 具有冻结消费面、来源标签清洗、有限调用/字节/并发/队列预算；这些是支持路径约束，不是同进程插件的 OS 隔离边界。

## 权威规则

- 文档与源码冲突时先查源码和测试，再在同一变更中修文档。记忆文件保持短小、使用绝对日期，不记录聊天流水账。
- `docs/agent-taskpacks/` 只保留历史协作索引，不是当前执行入口；已完成旧 taskpack 与旧真机测试笔记已清理。
- 状态写入必须保留无关 key、使用现有锁/合并行为，且不在日志/API 暴露凭证。公共仓库不作为开发 relay。
