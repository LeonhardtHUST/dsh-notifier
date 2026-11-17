# dsh-notifier 当前交接快照

更新时间：2026-11-17。维护 fork：`LeonhardtHUST/dsh-notifier`；npm：`@leonhardthust/dsh-notifier@0.14.0`；上游：`THEWOLFWALKER/dsh-notifier`。当前从 `origin/dev@aabc7d7` 建立的 `codex/rc3-scoped-release` 完成代码与发布准备，尚未首次 npm 发布。历史发布快照保留在 `docs/new-host/history/` 和 CHANGELOG，本文件只描述当前状态。

| 测试 | `npm test` **2084 tests**（2084 pass，0 fail，0 skip；隔离临时 `DSH_HOME`，并发上限4） |

## 已实现

- #45/#46：OutboundSource 保留 JSON clone/deep freeze；QQ Bot、WeCom app、desktop、ServerChan 发送运行态在模块私有 WeakMap，不再写冻结配置。测试覆盖 cold/hot replace、token 复用/刷新、seq 重试、探测/告警 latch、跨配置隔离。
- #49/#51：DSH 精确目标 `0.2.2-rc.3`；optional session peer 同版本、Cordis `~4.1.0`；静态 inject 仅 tools/agents，Web Fiber 可选，headless 不再 PENDING。生命周期监听器同步执行副作用并返回 Promise，拒绝被容错处理。
- scoped package、Cordis patch name、Native client factory ID 均为 `@leonhardthust/dsh-notifier`；插件行、service、RPC 和 state namespace 保持 `dsh-notifier`。同一 profile 不能与原 unscoped 包共装。
- 继承 dev 的状态 schema/命令准入收紧：旧/未知状态不作为身份与凭据权威；首次显式写前保留 `state.json.pre-v0.14-legacy.<timestamp>`，升级前备份并重新配置/配对；不能手改 schema 绕过。assets/quiet 能力默认关。
- CI：main 版本变更触发完整发布门，OIDC 发布限 `main` 和 `npm-release` 环境；当前 `NPM_AUTO_PUBLISH=false`。上游每日同步只提 PR 到 fork dev，保护 fork 包/客户端/工作流，显式 dispatch 只读 CI；冲突、失败、超时等以去重 issue @LeonhardtHUST 通知，不自动合并或发版。

## 验证与审查

- 最终隔离完整回归：2084/2084；无资源上限的并发加其他 focused 进程曾触发短超时，默认 npm test 已固定 concurrency=4。日志在系统临时目录，不进 git/npm。
- release/host guard、28 渠道矩阵、src/client 语法、npm pack payload guard 通过。npm archive 不含 agent 配置、automation scripts/tests、host harness；FORK_RELEASE 指南随包发布。
- Flash 独立审查：focused 411/411、rc3 host smoke 19/19（web 401 admission、headless 本地 HTTP POST、真实 Cordis EventContext 9/9）。Sol 只读供应链复审通过；发现的机器人 git 身份、checks:read、scoped 客户端保护和失败状态告警已修订。
- 远端已设置：Issues 开启；Actions 默认 read；允许 GITHUB_TOKEN 创建 PR；npm-release 环境仅 main；自动 npm 发布关闭。尚需真实 CI/npm/OIDC 验证。

## 发布步骤与授权

用户已授权 push 此 fork、更新 dev/main、创建 tag/Release、配置 Actions 及首次公开 scoped npm 发布；npm 用户 `leonhardthust` 已自行 web login/2FA。无上游写权限，不向上游 push。

1. 提交最后计数与交接，确认 clean；推送 topic/dev，等待 CI。
2. fast-forward main 到同一 reviewed dev commit，等待 Release verify。
3. 给精确提交创建不可变 `v0.14.0` tag，首次 `npm publish --access public --ignore-scripts`，校验 registry artifact。
4. 使用 `npm trust github @leonhardthust/dsh-notifier --file release.yml --repo LeonhardtHUST/dsh-notifier --env npm-release --allow-publish`；需要账户二次验证时由用户操作，不共享凭据。
5. 使用下一 patch 0.14.1 实测 OIDC/provenance，通过后启用 `NPM_AUTO_PUBLISH=true`；测试上游检测及通知。

## 剩余证据边界

- QQ #26 的真实按钮渲染仍未验证，不能用 label/permission 契约测试宣称修复；#25 是原作者维护公告。
- 真实 IM/provider payload、ACK、重连、媒体限制、桌面 BurntToast、rc3 Native 浏览器渲染未新增实测。隔离宿主/本地协议测试不等于真实渠道送达。
- npm registry-artifact 安装和真实 Actions/OIDC 结果在发布后补证，见 `docs/FORK_RELEASE.md` 和 `docs/memory/risks.md`。

## 提交与工程入口

代码基线 `aabc7d7`；本轮主要提交：`d4266b3` adapter 修复、`31d3a5d` rc3/生命周期、`e71dd66` 测试可移植性、`7ea53d7` 公共文档、`8c10a60` release/sync CI、`398aa93` scoped 整合、`d745f7c` 机器人身份/保护路径、`1b0aa96` 告警兼容。细节及 docs 提交见各 `.agents/workstreams/rc3-*.md`。

后续先读 AGENTS、docs/KNOWLEDGE_BASE、docs/memory；运行时以 src/test 为准，版本以 package.json 为准。`docs/new-host/` 的 rc5 T00–T29 是历史计划，不表示全部完成。
