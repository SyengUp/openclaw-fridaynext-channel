# 网关完整包部署与回滚

2026-10-22 更新。现有 Mac mini 的默认 SSH 入口为 `192.144.160.181:5023`，登录用户 `syengup`；官方 OpenClaw `2026.10.5`、Node `26.4.0`，宿主 HTTP 端口为 `18789`。新入口已核对与原局域网主机 `192.168.1.133` 相同的主机密钥。本流程不升级宿主、不修改 OpenClaw core，也不发布 npm。入口为 `scripts/deploy-gateway.sh`；本地编排在 `deploy-gateway.py`，SSH 执行与故障台架共用 `gateway_deployment.py`。

Kit `0.1.3` 已独立发布到 npm。源码的依赖声明和锁文件指向 registry；`package:registry` 用于正常 npm 安装，`package:pack` 从同一精确版本组装离线部署包。下述事务只接受后者，目标网关无需临时联网下载 Kit。

已发布版本可加 `--registry-version <精确版本>`：此模式用完整包验证、备份和保留离线回退材料，通过 SDK 官方 npm 安装事务更新生产代码及安装记录。网关此时会联网获取插件和 Kit；不带该选项的完整包覆盖模式继续支持离线换包。

尚未发布的候选版本可加 `--install-archive`：隔离环境先通过 SDK 正式安装同一个完整包，再运行合同；生产随后使用官方 archive 安装，并如实记录新版本与 archive 来源。该模式复用 registry 安装的完整快照、失败回退及手动回滚，保留当前用户数据，不需要发布 npm。

## 操作

先取得用户对部署／重启的明确授权，再从插件仓库执行：

```bash
# 只读检查当前 SDK、权威安装位置和健康。
./scripts/deploy-gateway.sh --inspect

# 构建包含全部生产依赖的包；不依赖目标机联网安装。
pnpm package:pack /tmp/friday-release
shasum -a 256 /tmp/friday-release/syengup-friday-channel-next-2026.10.3.tgz

# 只验证，不停止生产。
./scripts/deploy-gateway.sh --verify-only \
  --package /tmp/friday-release/syengup-friday-channel-next-2026.10.3.tgz \
  --expected-sdk 2026.10.5

# 部署固定产物；SHA256 替换为上一步取得的哈希。
./scripts/deploy-gateway.sh \
  --package /tmp/friday-release/syengup-friday-channel-next-2026.10.3.tgz \
  --sha256 SHA256 --expected-sdk 2026.10.5

# 用部署回执中的备份 ID 回滚。
./scripts/deploy-gateway.sh --rollback BACKUP_ID

# 未发布候选包：SDK 官方 archive 安装，验证成功后才停止生产。
./scripts/deploy-gateway.sh --install-archive \
  --package /path/syengup-friday-channel-next-2026.10.4-beta.2.tgz --sha256 SHA256
```

省略 `--package` 时会先在本机构建完整包。`--host`、`--ssh-port`、`--state-dir`、`--sdk-root`、`--node` 和 `--backup-root` 可覆盖目标；SSH 默认地址／端口也可由 `GATEWAY_HOST`／`GATEWAY_SSH_PORT` 覆盖。SSH 命令和 SCP 上传使用同一端口配置。默认备份根为网关的 `~/.openclaw-deploy-backups/friday-next/`。本地回执在 `.artifacts/deploy/<操作 ID>/`。不提供跳过验证、只覆盖 dist 或同步后不重启的分支。

## 执行关卡

1. 本地固定 SHA-256，上传完整 tgz 与校验过的隔离验证器。远端再次校验哈希、包身份、声明、全部生产依赖和真实 SDK 版本。SDK 只以宿主 peer 提供，不能被打进部署包。
2. 使用同一个完整包，在随机 loopback 端口和全新状态根执行真实 SDK 验证。只有返回成功回执、版本完全匹配且不调用模型，才允许进入部署。
3. 从 SDK SQLite 的 `plugins.installedIndex` 读取安装位置；旧宿主才回退配置安装记录。保持唯一来源，不增加生产 `load.paths`。完整包覆盖模式保持原路径和安装记录；registry 模式交由 SDK 维护来源和代码代际路径，不手写索引。插件声明面必须与已接受的声明一致，官方安装命令仅确认同一组已授权能力。
4. 有活跃运行或待领取命令时退出。对部署／回滚加排他锁；在用户已明确授权的部署事务中使用官方 `gateway stop --force`（2026.10.5 的托管停止要求显式参数），并等待原监听进程退出，之后才备份和换包。
5. 完整 npm 项目备份包括原插件、祖先依赖、锁文件及项目元数据；另存配置、SQLite 一致性快照、频道数据和本次固定的 `package.tgz`。以同文件系统 rename 替换完整插件，使用官方 `gateway start` 启动。
6. 健康检查要求 JSON、插件版本、OpenClaw 后端描述、`canonical-v1` 及八项运行能力；原有服务身份／网关指纹存在时必须保持一致。失败自动恢复完整代码与依赖，启动旧服务并记录 `rolled_back` 或 `rollback_failed`。

备份目录权限为 `0700`，配置、数据库、tar 与 manifest 为私有文件。回执不输出鉴权令牌。备份包含凭证与用户数据，不能提交或上传到公开位置。

## 回滚语义

`--rollback` 校验备份 SHA、当前安装位置与 SDK 版本，然后停止服务、恢复整个代码项目并重新启动。它保留当前频道账本、会话、附件、通知状态、配置与 SDK 状态库，避免丢失部署后接受的新请求或重置身份。自动回退使用相同原则。

`data.tgz`、`openclaw.json` 和 `openclaw.sqlite` 是人工恢复依据，不自动回灌。若需要恢复用户数据，先停止服务、另存当前数据，再按请求身份对账后单独决定恢复范围。宿主 SDK 升降级、插件声明面变更、其他安装来源迁移不属于这项回滚。

registry 和 archive 模式另外保存实际运行代码及提升依赖组成的 `rollback-package.tgz`，并逐个备份 Agent SQLite。回退通过 SDK 正式安装该完整快照，允许 SDK 管理的代码路径变化；安装来源会如实记录为本地 archive。它不从 npm 重装旧版本号对应的发行包，因此能恢复此前尚未公开发布的本地修复。当前用户数据和 SDK 状态库仍保留。关闭且无 WAL 的数据库使用不可变只读视图；存在活跃 WAL 时正常读取已提交帧，不忽略最新安装记录。

已发布 beta 的更新示例：

```bash
./scripts/deploy-gateway.sh --verify-only --registry-version 2026.10.4-beta.1 \
  --package /path/syengup-friday-channel-next-2026.10.4-beta.1.tgz
./scripts/deploy-gateway.sh --registry-version 2026.10.4-beta.1 \
  --package /path/syengup-friday-channel-next-2026.10.4-beta.1.tgz --sha256 SHA256
```

registry 验证在全新测试状态中运行官方 `plugins install`，核对精确 npm 来源和 Kit 版本，再启动 SDK 网关执行合同。恢复队列的写入使用同版本完整包的适配器，测试网关实际加载 SDK 安装的 npm 副本；不向 SDK 管理的原始安装目录手工加入 SDK peer。测试配置保留官方安装器写入的元数据，避免触发宿主配置自动恢复保护。

## 验证证据

真实 SDK 隔离验证覆盖 15 类：注册与能力、持久准入后恢复一次、官方历史与新旧序列化、全文与请求关联、改名与置顶、模型／命令／工具目录、定时与投递频道、Talk 目录与脱敏配置、Agent 配置与会话设置、UUID 绑定、真实 `/help`、多设备投递去重、未知格式拒绝、幂等冲突及旧 v3 输出。2026.10.5 会话库异步准入完成后才检查历史，不将 HTTP 绑定当作数据就绪。

首次完整包验证真实复现缺失 `qrcode-terminal` 导致宿主拒绝注册；打包断言先 RED、补齐全部生产依赖后 GREEN。部署故障台架 `python3 scripts/test_gateway_deployment.py` 共 20 项，覆盖新服务失败自动回退、手动回滚及新数据保留、权威安装记录、排队／活跃任务、声明面、身份变化、哈希、归档越界、SDK peer 链接，以及兼容失败禁止进入部署。

插件全量单测 151 文件／1354 项，端到端 15 文件／43 项通过；lint 为 0 errors／297 条既有 warnings。本轮没有 App UI 改动。真机 UI、真实公网 App Attest、系统通知及旧 App 二进制完整验收仍由设备现场确认，不能用隔离测试替代。

## 2026-10-20 生产部署回执

- 网关 `192.168.1.133` 已部署插件 `2026.10.3`，实际加载 Kit `0.1.2`；宿主继续为 OpenClaw `2026.10.5`。操作 ID：`20261020T114043Z-e03f75ed`。
- 固定包 SHA-256：`8a4874c63f571bdeda187bc7482e7c4ff914174a273ffeb47db9b4d803059798`。网关备份：`/Users/syengup/.openclaw-deploy-backups/friday-next/20261020T114043Z-e03f75ed/`。
- 部署回执为 `deployed`；canonical-v1、八项通用运行能力、新旧健康接口、12 个生产只读接口和存量附件下载通过。账本身份、TLS 证书／私钥和公网分配文件的五项 SHA-256 均保持一致；FridayTunnel 只有一个本插件实例，个人 frpc 独立保留。
- 首次停止被新版 SDK 的显式确认保护拒绝，尚未换包；加入 `--force` 的 RED→GREEN 回归后完成部署。冷启动时 `nana` 被宿主的 SQLite reclamation 准入超时阻挡；保留 `nana-before-readiness-restart.sqlite` 一致性快照后受控重启，六个会话均恢复历史读取，未手工改库或修改宿主源码。
- SDK 的 `provenance-invalid` 来源提示在 2026-10-19 日志中已经存在；本次保留其唯一 npm 安装记录，没有声称重建了 registry 来源证明。网关自身公网探测也有部署前失败记录；隧道登录／注册成功和身份校验不等同于设备公网端到端验收。

回滚该次部署：

```bash
./scripts/deploy-gateway.sh --rollback 20261020T114043Z-e03f75ed
```

## 2026-10-21 beta.3 本地部署回执

按用户“先部署，不发布”的要求，固定完整包通过 SDK 官方 archive 安装更新为 `2026.10.4-beta.3`，Kit `0.1.2`、OpenClaw `2026.10.5` 不变；未发布 npm。操作 ID：`20261020T165928Z-86f88259`，完整包 SHA-256：`eae906d6013da41ec7ea025b74883c297edfb41ac5f9d15abaac1073ce87f27a`。

本次隔离检查新增真实 SDK 标准停止入口绑定与空闲无副作用，共 16 类通过；生产安装、canonical 健康、长期身份与唯一插件 frpc 均已核对。备份在 `/Users/syengup/.openclaw-deploy-backups/friday-next/20261020T165928Z-86f88259/`，回退命令为 `./scripts/deploy-gateway.sh --rollback 20261020T165928Z-86f88259`，保留当前用户数据。真实运行中的取消终态、无兜底错误与动画样本已确认，停止延迟继续调查，见 [停止桥专项](../reviews/openclaw-stop-compatibility-2026-10-21.md)。

## 2026-10-21 SSH 入口更新

用户指定后续通过 `ssh -p 5023 syengup@192.144.160.181` 连接同一 Mac mini。默认部署入口已同步，提供 `--ssh-port`／`GATEWAY_SSH_PORT` 覆盖；SSH 和 SCP 共用 `Port` 选项。原主机密钥已核对，新地址的默认 `--inspect` 通过，生产版本与服务实例身份保持不变。

SSH 命令及两次完整包上传均使用指定主机／端口的合同先 RED，再 GREEN；完整部署故障台架增加至 31 项通过。这次仅更新开发机连接入口并只读检查，没有部署、发布或重启网关。历史部署回执中的原地址保留原值。

## 2026-10-21 beta.4 文件正文修复部署

用户明确授权仅部署、不发布 npm 后，已通过 `192.144.160.181:5023` 部署固定 beta.4 完整包，SDK 仍为 2026.10.5、Kit 仍为 0.1.2，官方安装来源为 archive。操作 ID：`20261021T032508Z-740f34c4`；包 SHA-256：`35d09f4ba353514e3a9bac529186e79914020315bb47aa260a3463e02d30860b`。

同宿主 17 类隔离检查通过后完成托管安装，备份在 `~/.openclaw-deploy-backups/friday-next/20261021T032508Z-740f34c4/`。身份、TLS 与公网分配连续，原附件链接仍可用，用户确认原提示及两个附件预览、重进均正常。回退命令为 `./scripts/deploy-gateway.sh --rollback 20261021T032508Z-740f34c4`，保留当前用户数据；完整证据见 [文件正文专项](../reviews/file-attachment-user-body-2026-10-21.md)。

## 2026-10-21 beta.5 审批读取修复部署

用户明确选择“仅部署，不发布 npm”后，完整包 `2026.10.4-beta.5` 在实际 Mac mini 的 OpenClaw 2026.10.5 上通过 18 类隔离验证，以官方 archive 安装更新；Kit 保持 0.1.2。操作 ID `20261021T053747Z-09ed3c4c`，状态 deployed，SHA-256 `0117d72a477559b968aa176f08be2a7140378f2f46ed2fc87fd898db4af9a201`。

私有备份位于 `~/.openclaw-deploy-backups/friday-next/20261021T053747Z-09ed3c4c/`，包含旧代码及依赖、频道数据、配置、SDK SQLite 和六个 Agent SQLite；使用 `./scripts/deploy-gateway.sh --rollback 20261021T053747Z-09ed3c4c` 保留当前数据回退。身份、原审批和唯一插件 frpc 已核对，未发布 npm，未重装 App。用户随后确认自动弹出、执行和重进均正常，两个真实 guarded 样本的手机与 Kit 回执对账通过，详见 [审批专项](../reviews/approval-foreground-presentation-2026-10-21.md)。

## 2026-10-22 beta.8／Kit 0.1.3 部署

Kit 0.1.3 已独立发布并通过匿名空缓存安装及固定归档核对。用户授权的 beta.8 完整包由 registry 依赖构建，在实际 Mac mini 的 OpenClaw 2026.10.5 通过 22 类隔离检查后，以 SDK archive 事务完成部署；插件未发布 npm。

操作 ID `20261022T033723Z-5ad4bd0d`，状态 deployed，beta.7 → beta.8。固定包 SHA-256 `d94e98b3381bffa3e385516ce7be06a2bbd3d2fc3a3994cd24052be1b06c8267`，备份目录 `~/.openclaw-deploy-backups/friday-next/20261022T033723Z-5ad4bd0d/`，权限 0700。回退命令：

```bash
./scripts/deploy-gateway.sh --rollback 20261022T033723Z-5ad4bd0d
```

生产实际 Kit 100 个文件与发布归档一致，账本、TLS 和公网分配五项身份文件保持原字节；255 秒内没有探活失败或 frpc 重启，唯一插件 frpc PID 不变。用户确认蜂窝前台连接稳定，模型及侧栏定时任务／收件箱均正常，无需重装 App。根因、npm 阻塞恢复与完整验证范围见 [探活发布部署验收](../reviews/tunnel-health-kit-release-2026-10-22.md)。
