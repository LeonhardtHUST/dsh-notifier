# dsh-notifier 当前交接快照

更新时间：2026-11-23。维护 fork：`LeonhardtHUST/dsh-notifier`；npm：`@leonhardthust/dsh-notifier`。上游署名与历史发布保持不变。

## 任务状态 type:state

- `0.15.0` 仍是已发布版本（tag `v0.15.0` → `7d72ba3`，npm latest）。`0.15.1` 已在 `main` 上准备好，**尚未发布**。
- 宿主要求已从精确 `0.2.2-rc.3` 迁到精确 `0.2.2-rc.5`（本机安装的 Desktop 版本，Cordis 4.1.0）。未改动 `src/`、`client.js`，未增加运行时依赖、监听端口或鉴权方式。
- 仓库收敛为单一主线：`main` 是唯一长期分支，`dev` 与全部 `codex/*` 分支已在本地和 `origin` 删除。分歧历史保留为 tag `archive/v0.13.1-release`、`archive/core-distillation-v015`、`archive/thewolfwalker-patch-2`。

| 项目 | 0.15.1 基线 |
| --- | --- |
| 测试 | `npm test` **2231 tests**（2230 通过，0 失败，1 个 Windows symlink 跳过） |
| 宿主冒烟 | `node test/host/harness.smoke.mjs` 对 rc.5 **19/19** |

## 本轮改动 type:progress

- 声明面：`package.json` 的 `engines.dsh`、`@deepseek-ai/dsh-session` peer、`dshWorkshop.compatibility.dshVersions` 同步为 `0.2.2-rc.5`；版本升到 `0.15.1`，admin UI 角标同步。
- `docs/compatibility-matrix.md`：rc.5 升为 verified 行，rc.3 降为未复验行；22 条宿主 seam 按 rc.5 源码逐条重写证据与行号；升级指南 rc.3→rc.5 区间两条均判定与本插件无关；机器可读块与守卫脚本对齐。
- 用户文档与安装/诊断提示词中的宿主版本声明全部改为 rc.5（README、guide、AI_INSTALL、DIAGNOSTICS、TROUBLESHOOTING、KNOWLEDGE_BASE、OPERATIONS、PLUGINS）。带日期的历史证据保留 rc.3 原文。
- 分支纪律：`AGENTS.md`、`docs/VERSIONING.md`、`docs/FORK_RELEASE.md`、`docs/RELAY_BOOTSTRAP_PROMPT.md`、`docs/ROADMAP.md`、`docs/OPERATIONS.md` 改为单 main 模型；`.github/workflows/ci.yml` 的 push 触发去掉 `dev`。
- `scripts/upstream-sync.mjs` 的同步目标改为 `main`（`TARGET_BRANCH`），PR 正文和告警文案同步；`test/upstream-sync.test.mjs`、`test/v013-invariants.test.mjs` 的期望值跟着改。

## 验证与限制 type:dead-end

- 宿主冒烟先在**旧 manifest** 上复现了阻断：rc.5 宿主把 `engines.dsh: 0.2.2-rc.3` 判为不兼容，整行进入 `skippedBundles` 而不报错。改到 rc.5 后同一 profile 正常装配；未使用任何宿主版本豁免。冒烟结论包含 web 路由 401、headless 真实 webhook POST、Cordis 事件上下文 9/9。
- 一旦工作树正在被并行写入（例如另一个 agent 原子改写 `AGENTS.md`），冒烟复制插件目录会撞到临时目录 `ENOENT`；重跑即可。冒烟应选在工作树空闲时执行。
- 未驱动浏览器，槽位渲染、主题与 `__ModuleLoader__` 真实执行仍未复验；未做真机 provider/device 投递验证。
- 机器上只有 rc.5 构建，没有 rc.4 包与 rc.5 升级指南小节，所以 rc.4→rc.5 只能按 rc.5 实物对照既有记录，无法逐行 diff；新增字段（`agent/created` 的 `source`/`signal`、审批返回非白名单归一 `unavailable`、`ask()` 拒绝委派调用方、`turn/end` 的 `forked`）已记入矩阵。

## 下一步 type:goal

- 在干净 `main` 上跑完整门禁后发布 0.15.1：打 tag、走既有 OIDC 工作流，随后核对 npm 版本与 tarball。
- 授权后在单独测试环境从 npm 安装 0.15.1，重启 Desktop 确认「通知与控制」入口、一次出站通知与一次远程命令；真机证据仍单独记录。
- Linux GNOME/KDE 通知动作、Windows 通知点击与 macOS 纯文本回落仍是待补的真机缺口（见 `docs/memory/risks.md`）。
