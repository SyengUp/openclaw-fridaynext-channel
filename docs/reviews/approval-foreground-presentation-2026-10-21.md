# 会话前台审批未自动显示

用户确认审批到达时一直停留在会话页，没有卡片或弹窗；返回首页后可从收件箱手动打开，选择“允许一次”后执行成功，只有一条正确回复。已定位并修复插件的权威查询，用户选择“仅部署，不发布 npm”后，`2026.10.4-beta.5` 完整包已更新生产网关。用户随后确认“自动弹出，执行和重进均正常”，手机与 Kit 回执对账通过，本专项关闭；整体 P5 保持开放。

## 真实证据与根因

- 逻辑会话 `58C14A1C-03A8-46EC-8057-BAA2FB066B14`，请求 `46B82F00-7B96-4FCD-9156-5D426284F641`。
- 运行 `1edc159a-399f-4d6a-9acc-1122a0a6ed63`，审批 `4d288462-6b45-4c15-88ab-c14da586e8ee`，控制代际为两者以冒号连接。
- 真实归档共 29 帧：第 12 帧为审批 request，第 14 帧为 resolved／allow-once，第 28 帧 completed，第 29 帧为终态后的元数据。宿主审批账本为 allowed，验收文件已创建，用户确认唯一回复。
- 手机开发连接恢复后只读取得 SQLite：上述运行及 29 个事件身份均已提交，发送命令 succeeded；没有这张审批的通用控制响应命令。运行结束后的事件 payload 已由既有压缩流程清空，不能以此推断实时帧缺少内容。手机收件箱手动操作走原生管理能力，不等同于 Kit 控制响应已经通过。

会话页收到 canonical 审批请求后，先调用 `/friday-next/v3/controls/:id` 查询权威状态，才创建可操作弹窗。适配器原来用普通插件 HTTP 请求作用域调用 `approval.get`，只补了 `operator.approvals` scope。OpenClaw 2026.10.5 的统一审批读取还要求真实审批读取身份；此作用域没有设备身份，也没有经过 Gateway owner 鉴权，宿主因此隐藏记录并返回 not found。适配器将它转换为 control=null，App 按既有保护规则不显示旧事件。收件箱使用已验证的原生管理读取和提交路径，因而可以手动操作。

实际生产查询返回 control=null，但 SDK SQLite 中仍有该 allowed 记录，排除了终态记录已被保留期清理的解释。在全新 loopback 的真实 2026.10.5 宿主中，创建仅用于测试的待审批记录：宿主认证查询明确返回 pending，修复前同一记录的公共查询返回空，形成有效 RED。该测试只登记审批，不执行所显示的 `/usr/bin/true`，不调用模型或生产网关。

## 修复边界

- OpenClaw 适配层通过 SDK 公共 `gateway-runtime` 的固定只读 `approval.get` 调用，使用 SDK 解析的本机端口和凭证；宿主执行 owner 鉴权。该 device-less 本机读取明确请求 `operator.admin`，与现有 owner 管理能力的权限含义一致，不通过修改普通插件作用域伪造读取身份。请求使用 read-only shared state，不创建或变更宿主设备身份。
- 解析宿主 `presentation` 结构，保留 Friday 账本中的会话、运行和原控制代际。当前可用决定取自宿主 `allowedDecisions`，终态返回空选项；不使用旧请求归档复活卡片。
- 规范控制提交保留 exec／plugin／system-agent 的宿主归属，使用统一 resolver；缺少归属的旧 App 入口继续沿用兼容 resolver。未声明的决定在适配层拒绝。
- 没有 Friday 运行归属的全局审批继续留在 OpenClaw 收件箱，不构造空会话或新代际。询问仍使用其原有查询。
- Kit `0.1.2`、App 与 OpenClaw core 均无代码改动。公共路由、控制回执、投递和 ACK 仍由 Kit 承载。已核对 Kit 仅压缩有持久归档保障的事件，活动审批的关联不会被 ACK 清除，无需新增第二套控制账本。

## 验证与候选

| 检查 | 结果 |
| --- | --- |
| 真实请求单元测试 | 修复前 5 失败、1 通过；修复后覆盖权威查询、ACK／重开、终态、声明选项、查询故障与询问隔离，并补三类宿主归属及提交检查 |
| 插件 unit／e2e | 最终 1384／43 项通过；命令正常退出 |
| 构建与 lint | 构建和完整包检查通过；0 errors、297 条既有 warnings |
| 实际 SDK 源目录隔离 | 18 类通过，新增审批查询、ACK 后恢复、允许一次、拒绝、终态、重复回执及冲突；无模型调用或命令执行 |
| 固定完整包的 SDK 官方 archive 安装 | OpenClaw 2026.10.5／Node 26.4.0 的全新状态中 18 类通过；权威安装来源为 archive，自动使用内嵌 Kit 0.1.2 |
| 实际 Mac mini 宿主与部署 | 重复 18 类检查通过，官方 archive 安装 beta.5；身份与原审批对账通过 |
| 真机自动呈现 | 用户确认自动弹出、执行和重进正常；两个 guarded 样本各一次 exec、一个成功控制命令及唯一最终回复，手机与 Kit 回执摘要相符 |

完整包为 `.artifacts/held-releases/2026.10.4-beta.5/deployment/syengup-friday-channel-next-2026.10.4-beta.5.tgz`，SHA-256 为 `0117d72a477559b968aa176f08be2a7140378f2f46ed2fc87fd898db4af9a201`，1122346 字节。与 beta.4 比较，所有生产依赖字节保持一致，Kit 继续精确依赖 npm `0.1.2`；新增模块只有 OpenClaw 审批读取桥及其声明。固定产物、测试、源码摘要及部署状态在相邻 manifest 留存，尚未发布 npm 或提交源码。

新隔离用例的第一次继续验证曾误用单数 `/response`，得到 404；已按生产契约改为 `/responses`。这属于测试入口错误，与前述真实 pending→null 的有效 RED 分开记录。

## 生产部署与后续现场步骤

用户明确选择“仅部署，不发布 npm（推荐）”后，固定包在实际 Mac mini／OpenClaw 2026.10.5 上重复 18 类检查，再执行托管停止、完整备份、SDK 官方 archive 安装和启动。操作 ID 为 `20261021T053747Z-09ed3c4c`，状态 deployed；Kit 保持 0.1.2，无需重装 App。

备份 `/Users/syengup/.openclaw-deploy-backups/friday-next/20261021T053747Z-09ed3c4c/` 权限 0700，包含实际旧代码和依赖、频道数据、配置、SDK SQLite 与六个 Agent SQLite。保留当前数据的回退入口为 `./scripts/deploy-gateway.sh --rollback 20261021T053747Z-09ed3c4c`。

部署后，同一张真实审批从 control=null 恢复为 resolved／allow-once，原逻辑会话、运行和控制代际一致，操作选项为空。原运行保持 completed、lastRunSeq=29，历史只有一条精确成功回复。服务身份及网关指纹不变，账本／TLS／公网分配五个身份文件与备份摘要一致，本插件 frpc 只有一个实例，另有一个其他 frpc 进程。

`P5-APPROVAL-AUTO-1021` 的专用路径 `/tmp/fridaynext-p5-approval-auto-1021-09ed3c4c.txt` 在部署后只读确认不存在。用户完成自动弹窗、允许一次及返回重进，确认全部正常。账本中存在三条带此标记的独立请求；其中一条未声明 guarded、没有审批事件，不计入审批通过样本。其余两个 guarded 样本在新逻辑会话 `1BAE4252-76AF-4F45-937E-B406B5B445E9`，分别为：

| 运行 | 请求／审批 | 对账 |
| --- | --- | --- |
| `11132d11-94ea-4e08-83f8-9457afdbdee5` | 请求 `19761191-F029-4C1F-8DA4-5DE4606136A0`；审批 `9454985e-de3a-4bb5-8628-c74643c4d5af` | 31 帧连续，唯一 exec 调用，request→allow-once→completed，唯一最终回复 |
| `95ca8820-5cd0-4e82-b318-478a815426ba` | 请求 `3C520CCB-288D-4D01-B4F5-B2F09D85D848`；审批 `47782e4a-da4e-40a7-908e-3f5ff2059242` | 27 帧连续，唯一 exec 调用，request→allow-once→completed，唯一最终回复 |

两张审批各对应手机中一个 succeeded 的 controlResponse 命令，attempt_count=0；原控制代际、run／session／profile 与网关一致。Kit 通用 control 成功回执的 payloadHash 与手机实际提交的 requestId／generation／answer 逐字节摘要相符。原生 approval 回执与 Kit control 回执属于两层，不是两次执行；agent 与 tool-hook 的 start 帧使用同一个 toolCallId，也不能计成两次工具调用。已结束卡片查询均为 resolved 且无选项。

只有这两个 guarded 样本计入审批正向通过，不能把三条独立请求合并为“一次执行”。自动呈现缺口关闭；后续待审批冷启动及拒绝样本见下，过期、其他端解决和控制断网等仍属于后续 P5 关卡。验收结果在 `.artifacts/device-acceptance/20261021-approval-foreground/auto-acceptance-result.json`，完整包 manifest 已标为 deployed-device-confirmed，源码仍未提交。

P5 总进度见 [验收记录](../../../Friday/docs/reviews/channel-kit-device-acceptance-2026-10-20.md)。私有原始数据位于 `/var/folders/nc/l06s87s51v53lmjw2h8wlq000000gn/T/friday-p5-approval-1021-szprcyto/retest/`；仓库 fixture 保留必要事件和展示结构，移除了实际工作目录，不含配置凭证或附件引用。


## 待审批冷启动与拒绝样本通过

用户确认 `P5-APPROVAL-DENY-1021` 的强退后审批恢复、拒绝与重进正常。真实人工审批请求 `C15598B3-AD77-41AE-BEC2-03B9F20EAE41`，运行 `558f6607-87ec-4eb8-8093-eacf77ab51d3`，逻辑会话 `61AED078-1D7B-4B09-B78B-F49B6B878836`，审批 `40f94af6-447b-4357-b8f0-1b7a3ea4f0b3`。

29 帧连续，第 12 帧 request、第 15 帧 resolved／deny，控制代际始终为原 runId:approvalId。手机发送和 controlResponse 各一条、均 succeeded 且 attempt_count=0；Kit control 回执摘要与手机实际 requestId／generation／deny 完全一致。SDK 原生审批为 denied；唯一 exec 工具结果为 user-denied、exitCode=null、durationMs=0，未进入命令执行。最终只有一条 `P5-APPROVAL-DENY-1021` 回复。手机日志记录该会话在拒绝前重新冷读，卡片显示与重进由用户确认。

同一测试文字另有一条新会话请求 `C80F16A8-A677-4974-8E26-D9D7A36AB9CC`，运行 `beeb42c9-af29-4572-a511-76472faee556`，没有 permissionMode=guarded，由宿主 Guardian 自动允许，工具 exitCode=0。目标文件当前存在，但 birthtime 为北京时间约 13:53:08.889，与第二条 touch 执行时间一致，晚于第一张审批的 13:52:53.247 拒绝；不能据文件当前存在判定被拒绝的命令执行了，也不能把两个不同请求合并为重试。

第一条请求的恢复、原身份提交和拒绝已在端到端数据中核对。用户明确确认“是，我另开会话又发了一次”，第二条为手动重测，排除异常恢复重放。冷启动恢复、原审批身份提交、拒绝不执行、唯一回复及重进无旧卡片的基础样本通过。私有证据位于原审批证据根的 `deny-cold/`，没有新代码、部署、重启或 npm 发布。
