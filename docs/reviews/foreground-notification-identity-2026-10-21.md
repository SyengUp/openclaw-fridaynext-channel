# 前台通知横幅被会话身份错配提前撤销

2026-10-21。用户在另一个会话等待 P5-FOREGROUND-PUSH-1021 完成，横幅只出现一瞬间就自动消失；用户确认期间没有点击、切换页面或切出 App。缺陷位于 OpenClaw 阅读状态适配，beta.7 已按用户授权仅部署，尚未发布 npm；横幅真机复验进行中。

## 真实数据与写入点

本次有两个不同请求，间隔约 58 秒。用户明确确认第二次是手动重发，不计为 Outbox 重放或重复执行：

| 请求 | 运行 | 服务端终态 |
| --- | --- | --- |
| 3E03E477-323B-41CF-B5A8-CE10FADCEDA4 | a8c6644f-893a-4ee5-be39-12c66302dcc6 | completed，26 帧 |
| 42BEA0AA-C63B-4191-9EC9-A93B184E3C07 | 25613eb7-7537-4a4e-9b48-89450316f4f5 | completed，23 帧 |

规范快照和本机会话列表使用逻辑 ID `5B7C03E6-C13E-43F7-950D-657C73E6EA0A`，底层原生 key 为 `agent:operator:fridaynext:070b5a93-fa90-42e4-91d6-ff8d570b76cc`。手机显示的是另一会话 `189E295E-1639-4EBC-9DF2-0C62FD4100A4`。

`GET /friday-next-admin/sessions/state` 返回 complete=true，但清单只有原生 key、没有通知使用的逻辑 ID；本机显式 aliases 也没有该映射。手机通知存储的 seen 已包含这两条完成身份，records 已无对应记录。真实日志显示完成附近发生目录对账，符合以下实际调用链：

`HistorySync.refreshSessionList → sessionListDidRefresh → SessionNotificationCoordinator.reconcileSessions → removeRecordsForMissingSessions → removeBanners`。

客户端将权威清单中不存在的会话通知永久清除。服务端输出错了身份，导致仍然存在的目标被当作已删除。没有修改横幅的 5 秒计时，也没有放宽客户端删除或过期撤销保护。首次容器读取遇到 CoreDevice 连接重置，重试后已取到实际日志、通知存储、sessions 和 aliases；未主动截图。

## 修复与兼容

- 新 App 已在 REST 请求携带 canonical-v1 协商头。该模式下，插件先把 SDK 原生 key 映射为逻辑 ID，再输出阅读状态，与事件、目录及快照一致；逻辑 ID 精确比较，大小写不同的身份不归并。
- 旧 App 不携带协商头，继续取得原生 key，保留原有兼容行为。
- PATCH 的逻辑 ID 先映射为原生 key 再交给 sessions.patch；expectedSessionId、expectedMarkedUnreadAt 和 null 护栏原样保留，响应仍回显调用方身份。
- 全部映射留在插件 OpenClaw 专属适配边界，不向 Kit 或 App 添加宿主 key 规则，不修改 OpenClaw core。

## 验证和后续

真实最小数据在 `src/http/handlers/fixtures/foreground-notification-session-identity-2026-10-21.json`。新增逻辑身份清单、区分大小写、旧客户端兼容及带护栏 PATCH 四项；修复前 3 失败／5 通过，修复后定向 8 项全部通过。完整 unit 1392 项、e2e 43 项通过，lint 为 0 errors／297 项已有 warnings，构建通过。

官方 SDK 隔离验证另补 canonical／旧清单身份和真实标记未读／带代际确认，在本机官方 SDK 2026.10.5 副本上以冻结完整包通过 22 类检查，未连接生产、未调用模型。实际 Mac mini 同宿主重复检查留给获得授权后的部署脚本。

候选插件 `2026.10.4-beta.7`，Kit 固定 0.1.2。完整包 1122797 字节，SHA-256 `8a8193c8e4cec04114aca4e2153b34ced5d6f6e82273750f7b6078e55c45d267`，保存在 `.artifacts/held-releases/2026.10.4-beta.7/deployment/`。487 个生产依赖文件与 beta.6 完全相同，包内仅 README、版本元数据和已读状态编译模块变化；源码摘要及测试结果在相邻 manifest。

用户明确选择“仅部署 beta.7，不发布 npm”后，脚本在实际 Mac mini 重复通过 22 类检查，再执行完整备份、SDK 官方 archive 安装和托管启动。部署 ID `20261021T120508Z-738c6eb2`，beta.6 → beta.7，无需重装 App；回滚入口为 `./scripts/deploy-gateway.sh --rollback 20261021T120508Z-738c6eb2`，保留当前数据。

生产 canonical 完整清单已包含原通知逻辑 ID、不再泄露该原生 key；旧版清单继续包含原生 key。serverInstanceId／gatewayFingerprint 连续，账本 server.json、TLS 私钥／完整链、域名与分配身份五个文件均与备份逐字节相同，备份 0700，插件 frpc 一个实例。横幅实际保持与点击跳转待用户用新 P5-FOREGROUND-FIX-1021 真机复验，旧通知的 seen 不清除、不重新弹出，相关 UI 结论确认前不提交。

私有证据通过 `/tmp/friday-p5-remaining-root.txt` 定位到 `foreground-notification/`；总进度见 [非语音 P5](../../../Friday/docs/reviews/channel-kit-p5-nonvoice-2026-10-21.md)。
