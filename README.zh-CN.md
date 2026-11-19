本维护分支以 `@leonhardthust/dsh-notifier` 发布，仓库为 [LeonhardtHUST/dsh-notifier](https://github.com/LeonhardtHUST/dsh-notifier)，上游原项目为 [THEWOLFWALKER/dsh-notifier](https://github.com/THEWOLFWALKER/dsh-notifier)。发布和上游同步见 [fork 发布指南](docs/FORK_RELEASE.md)。

目标宿主为 DSH **0.2.2-rc.3**。本版包含 dev 分支的 fail-closed 状态格式迁移：升级前备份状态，未带版本标记的旧身份和凭据状态需要显式重新配置。同一 profile 不要同时安装 scoped fork 与原包，两者共用运行时服务、路由和插件行。

<p align="center">
  <img src="docs/assets/readme-hero.png" alt="dsh-notifier — Agent ⇄ User, across every channel" width="100%">
</p>

<div align="center">

# dsh-notifier

**Your agent, in your pocket.**

把 DeepSeek Harness 放进手机里：**28 个出站通知渠道、6 个入站控制渠道**，通知、审批、提问、远程会话和任务/Session 控制统一收口。

[English](README.md) · [快速指南](docs/guide.md) · [排障](docs/TROUBLESHOOTING.md) · [兼容性](docs/compatibility-matrix.md)

<p>
  <a href="https://www.npmjs.com/package/@leonhardthust/dsh-notifier"><img src="https://img.shields.io/npm/v/@leonhardthust/dsh-notifier?style=flat-square&logo=npm&logoColor=white" alt="npm version"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-2ea44f?style=flat-square" alt="MIT license"></a>
  <a href="https://dshfind.com/zh/plugins/THEWOLFWALKER/dsh-notifier?ref=badge"><img src="https://dshfind.com/api/badge/THEWOLFWALKER/dsh-notifier?lang=zh" alt="dshfind"></a>
</p>

</div>

`@leonhardthust/dsh-notifier@0.15.0` · test/ 2231 个测试 · 2231 个自动化契约测试

## 它解决什么

dsh-notifier 是 DeepSeek Harness 的通知与远程操作层。最核心的使用场景很简单：**你离开 DSH 窗口以后，仍然知道 Agent 在干什么；需要你时，直接从手机处理。**

- **随时收到通知**：任务完成、审批、错误、长任务状态，以及模型主动触发的通知。
- **手机直接处理**：批准/拒绝、回答 `ask_user`、继续对话、纠偏正在执行的任务、切换任务或 Session。
- **日常管理留在 DSH**：Native **「通知与控制」** 是主入口；高级管理台只负责成员、绑定、Session、诊断和 Recovery。
- **失败尽量局部化**：未知/未绑定的入站操作 fail-closed；单个通知渠道失败不拖垮其他渠道。

## 界面预览

<table>
  <tr>
    <td><img src="docs/screenshots/admin-gate-desktop.png" alt="dsh-notifier 管理台解锁门" width="600"></td>
    <td><img src="docs/screenshots/fresh-wizard-desktop.png" alt="dsh-notifier 桌面端初始化向导" width="600"></td>
  </tr>
  <tr>
    <td><img src="docs/screenshots/fresh-wizard-step2-desktop.png" alt="dsh-notifier 初始化向导渠道选择" width="600"></td>
    <td><img src="docs/screenshots/configured-channels-desktop.png" alt="dsh-notifier 桌面端通知渠道页面" width="600"></td>
  </tr>
  <tr>
    <td><img src="docs/screenshots/fresh-wizard-mobile.png" alt="dsh-notifier 窄屏初始化向导" width="390"></td>
    <td><img src="docs/screenshots/configured-channels-mobile.png" alt="dsh-notifier 窄屏通知渠道页面" width="390"></td>
  </tr>
</table>

## 安装

### 一句话让 AI 帮你装

把下面这句话发给**能操作当前机器终端**的 AI / Agent：

> 请安装或升级 **@leonhardthust/dsh-notifier**。先识别当前 DSH profile 和安装来源，核对 DSH / Node 兼容性并备份配置。不要与原来的非 scoped 包并存，不改无关插件，不打印凭据。按本 fork 的旧状态迁移说明操作，重启对应 Host，确认安装版本和「通知与控制」入口，再报告结果。项目：`https://github.com/LeonhardtHUST/dsh-notifier`

更完整、适合直接交给 Codex / Claude Code / Cursor / 终端 Agent 的版本见：[AI 安装指南](docs/AI_INSTALL.md)。

### 自己安装

```bash
dsh plugin add @leonhardthust/dsh-notifier@latest --profile <profile名>
```

安装后重启 DSH 一次，让新的 Host 插件和 `client.js` 装载。然后：

1. 从 DSH 侧栏打开 **「通知与控制」**，或进入 **Plugins → dsh-notifier**；
2. 选一个你已经在用的通知渠道；
3. 填凭证，点 **「保存并测试」**；
4. 如果提供方只确认 API 已接受请求，而没有端到端 receipt，请到手机实际确认；“provider accepted”不会被写成“确认送达”。

装好以后，**出站配置修改会 Hot Apply**。入站 SDK / WebSocket / 长轮询如果页面显示 **「等待重启」**，仍需要重启来重建连接。

## 桌面通知还是远程渠道？

Native「通知与控制」把两者分开：

- **桌面通知**只在这台电脑上显示。Windows 10/11 通过 `powershell.exe` 调系统自带 Toast API，不需要 BurntToast 模块，也不写注册表或快捷方式。Linux 先走 `notify-send`，缺失时回落到 `gdbus`；支持 GNOME 和 KDE Plasma，其他桌面环境按标准方式尝试，但未专门适配。macOS 通过 `osascript` 走通知中心。在「桌面通知」里打开开关，再发一条测试通知即可。
- **远程通知渠道**用于离开电脑以后，需要 provider 凭证并通过网络安全发送。下面的出站列表共 28 项，其中 26 个是远程渠道，Bell 和 Desktop 属于本机。

Windows 路径已在真实 Windows 11 26H2 桌面验证，包括空标题/空正文和边界脚本。Linux 路径只有契约测试：本版没有 Linux 桌面真机运行记录。Windows 上 WinRT Toast 不可用时会回落到 NotifyIcon 气球提示，这条路径无法控制静音，所以「静音」设置可能不生效，气球约 3 秒后消失。

没看到弹窗时，先检查系统的勿扰/专注模式。

## 会话通知

会话通知共用一套投递规则，支持应用内浮层、系统通知和普通远程渠道。DSH 插件设置中的显示名为「消息通知」（英文 Notification）。契约和协议测试已覆盖；浮层、系统按钮和已认证 DSH Desktop 会话仍待真机验证。

矩阵在「通知与控制 → 桌面通知 → 通知投递」里。每个类别为浮层和系统通知分别选择「始终 / 有焦点时 / 离开时 / 不投递」；远程渠道多一个「跟随在场状态」。审批和提问行不提供这个选项。

| 类别 | 浮层 | 系统通知 | 远程 |
| --- | --- | --- | --- |
| 等待审批 / 等待回答 | 有焦点时 | 始终 | 始终 |
| 会话开始 / 完成 / 取消 / 错误 / 状态 | 有焦点时 | 始终 | 跟随在场状态 |
| 手动 `notify` 消息 | 有焦点时 | 始终 | 始终 |
| 待办 / 目标完成或取消 | 有焦点时 | 始终 | 跟随在场状态 |
| 待办 / 目标变更或暂停 | 不投递 | 不投递 | 不投递 |

矩阵只负责给已经产生的事件选去处；是否产生事件仍由宿主和现有的 `events.*` 开关决定。它不会自行打开「任务开始」或其他事件线。

跟随在场状态沿用现有远程抑制规则：电脑有焦点时，只有在桌面通知确实被系统接受后才跳过远程渠道。桌面发送失败、被会话静音，或 Linux 动作回执未验证时，被抑制的远程目标会补发。审批和提问默认始终远程，漏掉一次会卡住 Agent。

审批和提问事件延迟 1.5 秒再提醒；宿主在这个窗口内就结算的请求（policy 为 `never`、信号已取消、立即回答）不会弹通知。限时 `ask_user_question` 返回 `pending: true` 时仍算等待，之后的 `user-question-reply` 才取消提醒。

待办和目标按宿主载荷推断：todo 列表没有取消/暂停状态，未完成条目消失算取消，`in_progress` 回到 `pending` 算暂停；goal 的 `clear` 算取消，`block` 归入暂停。暂停类默认关闭。

### 浮层、静音与系统动作

浮层有六个位置、六种入场动画、堆叠开关和上下堆叠方向。堆叠时最多四张，关闭堆叠只保留最新一张。顶部位置跟随宿主的 `--dsh-frame-overlay-top`（缺失时 20px），底部用 20px，卡片列宽最多 380px。系统开启「减少动态效果」时不做入场动画。点击卡片打开对应 Session，菜单里是配置好的静音档位。

静音按会话生效，同时屏蔽三个去处。默认档位为 5、10、15、30 分钟和永久；可改成最多八个不重复的值，每个是 1 到 10080 的整数或 `always`。没有会话归属的通知（例如启动晨报、诊断摘要和广播）不在这份列表里，也不受会话静音影响。

- **Windows**：只有 Host 绑定了本机回环 Web 服务，且 `http://127.0.0.1:<port>/#dsh-notifier-session=<id>` 精确通过校验时，实体 Toast 才带「打开会话」按钮；没有静音按钮。按钮渲染仍要在真实 Windows 会话里验证。
- **Linux**：`notify-send` 同时支持 `--action` 和 `--wait` 时，才提供「打开会话」和已配置的静音档位。最多同时观察 8 个进程，每个 60 秒。动作输出不是送达回执，被抑制的远程目标仍会补发。旧版 `notify-send` 和 `gdbus` 回落保持纯文本。
- **macOS**：纯文本。

已安装的 Desktop 只识别 `dsh://open` 用来聚焦自身，没有会话级 deep link，也没有通过文件或 IPC 传递会话 ID 的路径。上面说的「打开会话」是回环 Web URL，由通过认证的客户端消费。

设置保存在 `local:session-notifications` 和 `local:session-mutes`；Native RPC 为 `notifications.get`、`notifications.save` 和 `notifications.mute`。浮层队列最多 100 条、保留 90 秒，其他 epoch 的游标会被拒绝。分支没有改动已安装 profile，没有发布 npm，也没有新增真机证据。

## 你需要哪一种用法

| 你的目标 | 从这里开始 |
| --- | --- |
| 想在电脑前收到弹窗 | 在「通知与控制」打开「桌面通知」 |
| 离开电脑后也想收到任务通知 | 在「通知与控制」配置一个远程渠道 |
| 想在手机批准 / 回答问题 | 再配置一个支持的入站渠道，然后完成成员配对 |
| 想直接在手机和 Agent 对话 | 配对后，在机器人私聊直接发文字 |
| 想中途纠偏正在执行的任务 | 在已绑定私聊发送 `! <补充指令>` |
| 想管理成员、绑定、Session、Recovery | 从 Native 打开「高级管理台」 |
| Headless / 自动化部署 | 看 [完整指南](docs/guide.md) 的 YAML / CLI 部分 |

## 支持的渠道

**出站 28 个：** Bark、Bell、Chanify、Desktop、钉钉、Discord、飞书、Google Chat、Gotify、iGot、Mattermost、ntfy、OneBot 11、PushDeer、Pushover、PushPlus、Qmsg、QQ 官方机器人、Server酱、Slack、Microsoft Teams、Telegram、Webhook、企业微信群机器人、企业微信应用、WPS Bot、WxPusher、息知。

**入站控制 6 个：** Telegram、飞书、QQ 官方机器人、WxPusher、微信 iLink、钉钉。

**本机 2 个（含在上面的 28 个出站里）：** Bell、Desktop，从「桌面通知」开关配置，不出现在远程渠道列表里。

不同 provider 的按钮、附件、送达回执、重连、账号额度并不一样。项目只按真实证据等级声明能力，详见 [兼容性矩阵](docs/compatibility-matrix.md)。

<details>
<summary><strong>常用私聊命令</strong></summary>

| 命令 | 用途 |
| --- | --- |
| `/help` | 查看命令 |
| `/whoami` | 查看身份 / 配对状态 |
| `/status` | 当前路由 / Session 状态 |
| `/tasks` / `/use …` | 查看或选择活跃任务 |
| `/sessions` | Session 概览 |
| `/stop` | 停止当前 turn |
| `/route` | 查看双向路由 |
| `/quiet …` / `/unquiet …` | 静默 / 恢复通知 |
| `/pair <码>` / `/unpair` | 配对 / 解绑入站身份 |
| `/log [N]` | 有界、脱敏的近期通知摘要；默认关闭且仅 owner |

普通文字会继续和 Agent 对话；前缀 `!` 会纠偏当前正在执行的 turn。群聊默认不开放高风险远程控制语义。

</details>

## 工作方式

```text
DSH 事件 / notify() / 其它插件
                 │
                 ▼
        dsh-notifier core
        ┌────────┴────────┐
        ▼                 ▼
    28 个出站          health / activity
        │                 │
        ▼                 │
       手机               │
        │                 │
        └─ 6 个入站 ──────┘
              │
              ▼
       identity + Control Core
审批 · ask_user · 会话 · 任务/Session 控制
```

Native UI、notifier runtime、高级管理台和测试尽量围绕同一份真实状态工作，不维护“页面看起来已经改了、运行时其实没改”的第二套真相。

## 遇到问题：先让 AI 帮你定位，再上报

**不要一上来就把一大段日志贴进 Issue。** 推荐支持流程：

1. 把 [AI 排障提示词](docs/TROUBLESHOOTING.md) 发给能读当前终端/日志的 AI；
2. 先做**只读诊断**：确认实际安装版本、DSH profile / 版本、安装来源、问题属于哪个子系统，并做最小复现；全程脱敏；
3. 如果只是旧包、错误 profile、残留 `file:` 安装、漏重启、凭证或 provider 配置问题，让 AI 协助本地解决并重新验证；
4. 如果仍解决不了，让 AI 按 [定位与诊断指南](docs/DIAGNOSTICS.md) 生成一份短小、可复现的报告；
5. 再把这份报告发到 GitHub Issue / QQ 群 / 邮箱。

这样维护者拿到的是“已经排除常见环境问题后的证据”，不是聊天记录和猜测。

## 文档

| 文档 | 用来干什么 |
| --- | --- |
| [完整指南](docs/guide.md) | 安装、首访、出站/入站、配对、日常使用 |
| [AI 安装](docs/AI_INSTALL.md) | 一句话 / 完整提示词，让终端 Agent 安全安装 |
| [排障指南](docs/TROUBLESHOOTING.md) | 人类 + AI 的第一轮问题定位 |
| [定位与诊断](docs/DIAGNOSTICS.md) | 收集证据、生成 Support Report |
| [兼容性](docs/compatibility-matrix.md) | DSH / 可选 SDK / provider 的证据等级 |
| [升级指南](docs/upgrade-guide.md) | 更新、确认实际版本、清理残留、回滚 |
| [插件 API](PLUGINS.md) | `ctx.notifier` 消费方接口 |
| [架构](docs/architecture.md) | 内部设计与运行时权威 |
| [变更记录](CHANGELOG.md) | 版本历史 |

## 联系方式

可稳定复现的产品问题，优先走**AI 预排障后的 GitHub Issue**。

- QQ：**3622976831**
- 邮箱：**3622976831@qq.com**
- QQ 群：**947656156**

<p align="center">
  <img src="docs/assets/qq-group.png" alt="dsh-notifier QQ 群 947656156" width="300">
</p>

不要通过 Issue、QQ 或邮件发送 Bot Token、Webhook Secret、Admin Token、完整 `state.json` 或未脱敏的私聊内容。

本 fork 的问题请提交到 [LeonhardtHUST/dsh-notifier issues](https://github.com/LeonhardtHUST/dsh-notifier/issues)。上述联系方式属于原项目作者。

## 开发信息

Node.js **22+**、ESM、**零强制运行时依赖**。部分 provider 的扫码/接入能力使用 optional dependency，仅在需要时加载。

开发、验证和发布规则见 [AGENTS.md](AGENTS.md)、[OPERATIONS](docs/OPERATIONS.md) 和仓库测试。

## License

MIT
