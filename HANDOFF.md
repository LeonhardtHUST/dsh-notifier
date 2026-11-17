# dsh-notifier 当前交接快照

更新时间：2026-11-18。维护仓库 `LeonhardtHUST/dsh-notifier`，发布包 `@leonhardthust/dsh-notifier`；上游 `THEWOLFWALKER/dsh-notifier` 的署名与历史发布保持不变。

## 任务状态 type:state

- `0.14.1` 已发布。不可变 tag `v0.14.1` 指向 `58507ac`；npm latest、GitHub Release、OIDC provenance 与 registry tarball 已核对。topic/dev/main 在发布提交后仅补文档证据，运行中的 DSH profile 未改动。
- 已实现 Native 面板滚动、本机/远程通知入口分离、Windows 10/11 WinRT Toast、Linux notify-send/gdbus 回落。
- `local.get`/`local.save` 复用 canonical 出站事务；YAML 管理不能从 UI 关闭。撤销不会被启动快照复活；来源读失败报 storage-failed。
- `engines.dsh` 仍为精确 `0.2.2-rc.3`；无新增强制运行时依赖，无新增监听器或认证模式。

| 测试 | `npm test` **2137 tests**（2137 pass，0 fail，0 skip；隔离临时 `DSH_HOME`，并发上限4） |

## 验证与审查

- 独立 Sol 静态审查指出的空文本编码、配置撤销、YAML 无选项行、读失败假成功、开关禁用及诊断泄漏均已修复，并有回归覆盖。
- 最终完整回归 2137/2137，0 fail、0 skip。release/host/channel-matrix/syntax/payload 门禁均通过；npm dry-run payload 322 文件，无开发工具目录。
- Windows 11 26H2：真实 WinRT Toast 成功，归属 `com.deepseek.dsh`；恶意文本作为字面量存入通知 XML；静音 XML、空文本及最大长度脚本均在 PowerShell 5.1 验证。
- Chromium 复刻已安装 rc3 的 main slot 高度约束：旧布局 clientHeight=1532、scrollTop=0；新布局 clientHeight=565、scrollHeight=1532、scrollTop=400。

## 失败与弯路 type:dead-end

- Get-StartApps 探测 → 本机耗时 11–17 秒，已改为只检查 DSH 开始菜单快捷方式存在性并按冻结配置缓存。
- 并发运行多个全量套件 → 触发已有短计时测试抖动；最终全量统一串行执行。
- 直接打开 DSH GUI URL → 需要认证，本线没有宣称已安装新 Native UI 端到端验证，也未修改运行中 profile。

## 发布与下一步 type:progress

- CI `44129363178`：Ubuntu/macOS Node 22 全部通过。Release `44130646586`：验证和 OIDC 完成；npm 处理延迟导致首次后置校验失败，registry 可见后仅重跑失败 job，最终成功且未重复发布。
- Registry tarball 322 文件，SHA-512 与本地 pack 相同；SLSA statement 指向维护 fork 与 `58507ac1e295165c02ba73caa83b6da47a20806e`。
- 提交：`dc7106c` 平台通知、`d788898` Native 面板、`9819e90` 使用文档、`58507ac` 发布元数据。
- 下一步：更新实际 Desktop profile 后，在「通知与控制 → 桌面通知」测试；Linux GNOME/KDE、已认证 Native UI 端到端与真实 IM/provider 仍待补证。

工程入口：AGENTS、docs/KNOWLEDGE_BASE、docs/memory。运行时以 src/test 为准，版本以 package.json 为准。文档/记忆工具未暴露时使用 tracked docs/memory 和 workstream 留存事实。
