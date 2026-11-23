# dsh-notifier 升级指南

> 面向 DSH 用户：更新、确认版本、排查残留、0.13.x → 0.14.0 数据迁移、降级回滚。
>
> 英文版：[`upgrade-guide.en.md`](upgrade-guide.en.md)

## 一、更新到最新版

推荐：

```bash
dsh plugin add @leonhardthust/dsh-notifier@latest --profile <profile名>
```

如果你的 DSH CLI 不接受 `@latest`：

```bash
dsh plugin add @leonhardthust/dsh-notifier --profile <profile名>
```

也可以在 DSH 根目录走包管理器：

```bash
npm install @leonhardthust/dsh-notifier@latest
# 或
pnpm add @leonhardthust/dsh-notifier@latest
```

本包是维护 fork（仓库 `https://github.com/LeonhardtHUST/dsh-notifier`），原作者项目是
`https://github.com/THEWOLFWALKER/dsh-notifier`，归属保留。原包 `dsh-notifier` 与本 fork
**不要同时安装**：两者争用同一插件 id、服务名和状态目录。迁移时先移除原包。

### 更新后必须重启一次

升级包以后先重启一次 DSH，让新的 Host 插件和 `client.js` 装载。

**这次重启是“加载新版本”需要的，不代表 0.14.0 的出站配置仍然要靠重启生效。**

0.14.0 装载完成后，后续修改出站渠道是 Hot Apply；Native 与 Advanced Console 共享 canonical runtime truth。

## 二、v0.11 → v0.12 有什么变化

### 1. 主入口换了

以前：

```text
启动日志
→ 找 Web 管理台 URL/#token
→ 浏览器配置
```

现在优先：

```text
DSH Sidebar「通知与控制」
或 Plugins → dsh-notifier
→ 配渠道
→ 保存并真实测试
```

Standalone Web 管理台没有删除，但变成 **Advanced / Recovery**。

### 2. 出站配置保存后立即生效

v0.11 的「视图热、投递冷 / 重启后生效」对 v0.12 出站已经失效。

v0.12：

```text
save
→ validate / resolve
→ persist
→ OutboundSource 原子替换
→ 下一次发送直接使用
```

如果升级后你仍看到“出站必须重启才能生效”，先怀疑实际运行的不是 registry `0.14.0` 或更高版本。

### 3. 出站 state key 迁移

v0.12 新写：

```text
channel:<type>:outbound
```

旧：

```text
admin:channel:<type>:outbound
<type>:account
```

只保留兼容读取，不会自动删除。

canonical key 与 `admin.enabled` 无关；关闭 Advanced Console 不会让 Native 保存的出站配置失效。

### 4. 入站仍可能需要重启

入站 SDK/WS/长轮询 transport 没有在 v0.12 被统一热重载。

以 UI 显示为准：

- `hot`：立即生效；
- `restart`：重启后重新建立 transport；
- `readonly`：走既有授权/CLI。

## 三、确认你真的装到了 0.14.0

优先看三证：

| 证据 | 怎么看 | 正常表现 |
|---|---|---|
| DSH Native | 左侧栏 / Plugins | 有「通知与控制」与 @leonhardthust/dsh-notifier 设置入口 |
| CLI | `npm ls @leonhardthust/dsh-notifier` / `pnpm ls @leonhardthust/dsh-notifier` | `0.14.0`（或更高） |
| Registry | `npm view @leonhardthust/dsh-notifier version` | 与你期望的发布版一致 |

也可以核包：

```bash
node -p "require('./node_modules/@leonhardthust/dsh-notifier/package.json').version"
```

开发者/排障还可确认：

```text
exports["./client"] = "./client.js"
dshQuality.testCount = 2011    # v0.13.1 历史发布线；最终 0.14.0 数量以发布元数据为准
```

## 四、版本对，但功能像旧版

最常见：旧 `file:` 安装、手工覆盖 node_modules、pnpm 重新回滚了你手拷的文件。

排查：

```bash
pnpm why @leonhardthust/dsh-notifier
# 或
npm ls @leonhardthust/dsh-notifier
```

看到 `file:` / 本地绝对路径，说明你不是在测 registry 正式包。

最稳的处理：

```bash
dsh plugin remove @leonhardthust/dsh-notifier --profile <profile名>
dsh plugin add @leonhardthust/dsh-notifier@latest --profile <profile名>
```

然后重启 DSH。

不要靠“复制新源码覆盖 node_modules”做长期验证。

## 五、0.14.0 常见排障

### Native 入口没出现

检查：

1. 实际版本 `0.14.0+`；
2. DSH 已重启；
3. Host 是 `0.2.2-rc.5`；
4. `client.js` 确实在已安装包里；
5. web profile 的 Client Module/slot 没报错。

声明范围（`engines.dsh`，宿主预检只认它、忽略 `@deepseek-ai/dsh*` peer）：

```text
0.2.2-rc.5
```

`0.1.7-*` 与 `0.2.1-*` 不再声明支持：安装时会因 manifest 版本门被宿主预检拒绝（除非手工授予
exact-version 豁免，本插件不提供豁免）。

### 保存出站后仍要重启才生效

这是 0.14.0 的异常表现。核：

- 是否真的运行 `0.14.0` 或更高 registry 包；
- 是否是**出站**而不是 inbound；
- 页面/运行时是否都读 canonical `channel:<type>:outbound`；
- 是否有旧 `file:` 包残留。

### Advanced Console 打不开

0.14.0 不会为了打开它偷偷启用 `admin.enabled`。

如果你显式关闭 Admin，Native 会显示 unavailable。需要恢复时重新启用 Admin 或使用 YAML/CLI。

## 六、降级

本 fork 的已发布版本从 `0.14.0` 开始。要回退到更早功能线，需要回到原作者包
`dsh-notifier@0.13.1`；这会同时换掉包身份，因此先把 fork 移除，再安装原包。

```bash
dsh plugin remove @leonhardthust/dsh-notifier --profile <profile名>
dsh plugin add dsh-notifier@0.13.1 --profile <profile名>
```

### 降级前先备份 state

0.14.0 使用新的 state schema/namespace，0.13.x 不认识它写入的版本标记。降级前：

1. 备份 `state.json`；
2. 记录关键渠道配置（不要把 secret 发到 issue/log）；
3. 降级；
4. 必要时在原包的 Web 管理台或 YAML 重新配置出站，并重新配对。

不要为了兼容降级手改运行中的 state 文件，也不要让原包与 fork 同时存在。

## 七、DSH 宿主版本与 0.14.0 新数据 namespace

本插件自 0.15.1 起只对 DSH **0.2.2-rc.5** 声明激活（`engines.dsh`）；0.14.x/0.15.0 那批包声明的是 rc.3。
宿主的安装预检在插件自报
`engines.dsh` 时只认它、忽略 `@deepseek-ai/dsh*` peer，因此无需任何版本豁免即可安装。

### 七.1 旧状态不再作为权威

state store 现在带显式 schema/namespace 版本。启动时：

- 版本 = 当前版本：正常加载；
- **未知/旧版本**（例如 0.13.x 或旧 `0.1.7-*` 期写入的 `state.json`）：**不**把其中的
  身份绑定、待确认绑定、配对码、会话选择、游标当作权威——这些数据不执行、不授权；插件提示
  **重新配置 / 重新配对**，但**不会删除原文件**。
- 应用首次写入新 namespace 时，store 会生成
  `state.json.pre-v0.14-legacy.<时间戳>` 取证副本，然后才建立新 namespace。

因此升级后需要：在新版里重新配置渠道、重新 `/pair`。旧待决动作、旧配对码、旧账号归属成员
不会被继承。旧 state 的备份和取证副本都在同一 state 目录：
`$DSH_HOME/dsh-notifier/`（未设置 `$DSH_HOME` 时为 `~/.dsh/dsh-notifier/`）。

### 七.2 账号身份键

身份与授权主键为 `AuthorityKey = (channel, accountIdentity, userId)`（见
[CONTRACTS.md](new-host/CONTRACTS.md) §身份与数据版本）。本地别名 `default` 不是主体证明；
没有权威主体来源的 provider 会保守地重新建立本地账号身份并要求重新配对。

## 八、开发者：真机基准用 registry 包

`file:` 只适合临时开发。

发布前/问题复现基准应当是：

```bash
dsh plugin add @leonhardthust/dsh-notifier@latest --profile <profile名>
```

并核：

- registry 版本；
- package payload；
- Native client module；
- 一次真实 save/test；
- 一次 Hot Apply 后的真实下一次发送。

mock/contract 全绿不等于 provider/device 已验证。
