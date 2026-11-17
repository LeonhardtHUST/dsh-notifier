# AI 安装 dsh-notifier

这份文档给**能操作当前机器终端**的 AI / Agent 使用。

目标：

```text
确认环境
→ 找到正确 DSH profile
→ 安装 scoped fork 稳定版
→ 不破坏现有配置
→ 重启正确 Host
→ 验证实际版本
→ 验证 Notify & Control
→ 汇报结果
```

## 包身份与兼容范围

- 包名：`@leonhardthust/dsh-notifier`（维护 fork）。
- 仓库：`https://github.com/LeonhardtHUST/dsh-notifier`；原作者项目是 `https://github.com/THEWOLFWALKER/dsh-notifier`，归属保留。
- 宿主：只对 DSH `0.2.2-rc.3` 精确声明兼容（`engines.dsh`）。更早或更新的 DSH 版本会被安装预检拦下，除非用户明确使用宿主豁免；不要宣称支持未验证版本。
- 原包 `dsh-notifier` 与本 fork **不要同时安装**：两者导出同一组服务/事件名，会争用同一插件 id 与状态目录。迁移时先移除原包，再安装本包。

## 一句话版本

直接复制：

> 请帮我在这台机器上安装或升级 `@leonhardthust/dsh-notifier` 最新稳定版。先自动识别当前正在使用的 DSH profile 和现有安装来源，确认 DSH 是 `0.2.2-rc.3`、Node 满足要求，并保护已有配置；不要修改无关插件，也不要打印任何 Token / Secret。如果机器上装过原包 `dsh-notifier`，先确认并移除它，避免两者共存。安装后重启对应 DSH Host 一次，确认实际安装版本和「通知与控制」入口；如果这是从 0.13.x 升级到 0.14.0，提醒我先备份旧 state，并准备重新配对/重新配置。最后把你执行过的命令、结果和仍存在的异常汇报给我。

## 完整 Agent 提示词

```text
你正在帮助用户安装或升级 @leonhardthust/dsh-notifier。

项目（维护 fork）：
https://github.com/LeonhardtHUST/dsh-notifier
原作者项目（归属，不是本次安装源）：
https://github.com/THEWOLFWALKER/dsh-notifier

目标：
把当前机器上实际使用的 DSH profile 安装/升级到 @leonhardthust/dsh-notifier 最新稳定发布版，并验证真正运行的是新版本。

先做只读检查，不要直接改：

1. 识别 Node.js 版本。
2. 识别 DSH / Harness 版本，确认是 0.2.2-rc.3（本包只对此版本声明 engines.dsh）。
3. 找出当前运行/常用的 DSH profile；如果明确只有一个就使用它，如果有多个且无法判断，不要猜，列出来让用户选择。
4. 检查是否已经安装 @leonhardthust/dsh-notifier，以及是否同时装着原包 dsh-notifier。
5. 检查安装来源：
   - npm/registry
   - file:
   - Git
   - 手工 node_modules
6. 记录当前版本。
7. 不读取/输出完整 state.json，不输出 Bot Token、Webhook Secret、Admin Token、Authorization header。
8. 不修改其他插件。

确认环境后：

- 如果发现原包 dsh-notifier 与本 fork 同时存在，先停下列出冲突，经用户确认后只保留本 fork。
- 优先使用 DSH CLI 安装官方稳定版：
  dsh plugin add @leonhardthust/dsh-notifier@latest --profile <正确profile>
- 如果该 CLI 版本不接受 @latest，可退回：
  dsh plugin add @leonhardthust/dsh-notifier --profile <正确profile>
- 不使用未发布 dev 分支替代稳定版，除非用户明确要求。
- 不通过手工复制源码覆盖 node_modules 作为长期安装方式。

从 0.13.x 升级到 0.14.0 时额外做：

1. 在安装前让用户确认已备份现有 $DSH_HOME/dsh-notifier/state.json（或整个 state 目录）。
2. 不要手改旧 state，不要尝试伪造 __schema 标记。
3. 说明旧 namespace 的绑定、待决审批、配对码和凭证不会被当作权威；应用首次写入时会生成 state.json.pre-v0.14-legacy.<时间戳> 取证副本，原文件保留，随后需要重新配对、重新配置渠道（或扫码重建凭证）。

安装完成后：

1. 重启对应 DSH Host 一次。
2. 检查实际安装版本，不只相信安装命令输出。
3. 检查 package 中 client.js 是否存在。
4. 如果是 web/支持 Native UI 的 profile，确认：
   - Sidebar 有「通知与控制」/ Notify & Control；
   - Plugins 能看到 @leonhardthust/dsh-notifier。
5. 不要求用户先提供通知渠道 Secret 才能宣布“插件安装完成”。
6. 如果已有渠道配置，不要擅自删除、重建或改密钥；除非确认命中了 0.14.0 旧 namespace 隔离，此时按上面的重建步骤说明。
7. 如果安装失败，保留现场，进入只读排障，不要反复卸载重装。

最终只给用户一个短报告：

- profile
- Node 版本
- DSH 版本（应为 0.2.2-rc.3）
- 安装前包版本与来源
- 是否移除了原包
- 安装后实际版本
- 执行过的命令
- 是否重启
- Notify & Control 是否出现
- 是否发生 0.14.0 旧 state 隔离（备份文件名、重新配对/配置状态）
- 是否存在 file:/残留包风险
- 任何失败/警告
- 下一步

不要在报告里输出任何 Secret。
```

## 安装后下一步

打开：

```text
DSH → 通知与控制 → 通知渠道
```

配置一个出站渠道并「保存并测试」。

如果插件装好了，但页面不出现或行为像旧版，不要继续盲目重装，转到：

[TROUBLESHOOTING.md](TROUBLESHOOTING.md)

## 相关文档

- 升级步骤与 0.14.0 数据迁移：[upgrade-guide.md](upgrade-guide.md)
- 宿主兼容证据边界：[compatibility-matrix.md](compatibility-matrix.md)
- 诊断命令：[DIAGNOSTICS.md](DIAGNOSTICS.md)
