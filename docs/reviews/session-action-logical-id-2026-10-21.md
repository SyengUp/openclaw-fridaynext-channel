# 逻辑会话 ID 的分叉与回退修复

2026-10-21。P5 真机分叉返回 `session not found`。修复位于插件 OpenClaw 会话动作处理器，Kit 与 App 的不透明会话身份契约不变。完整包为 `2026.10.4-beta.6`，Kit 仍固定 `0.1.2`；已按用户明确授权部署，真机分叉与回退均获确认、生产数据对账正常，尚未发布 npm 或提交源码。

## 真实复现与写入点

用户在 App 新建会话完成 `P5-FORK-A1-1021`、`P5-FORK-A2-1021`，随后长按第二条用户消息分叉失败。逻辑 ID `5DD84E6F-4A8D-4C2C-8EA5-41CECE59EA32` 已持久映射到原生会话 `agent:main:fridaynext:16a44437-fde5-4760-8d85-89e9d1e030ae`；两次运行均完成，未发送分叉后的 B 请求。

生产只读 `sessions.resolve` 对逻辑 ID 返回找不到，对已映射原生 key 成功。`session-message-actions.ts` 原先直接把逻辑 ID 传给宿主 `sessions.fork/rewind`，运行中的任务保护和历史绑定也沿用错误身份。未在生产重复执行写操作来复现。

处理器现通过 OpenClaw 专属 `mappedNativeSessionKey` 精确查询映射，统一使用原生身份查询宿主、检查忙碌任务和绑定旧运行。没有映射的旧会话继续使用原值。共享核心和 Kit 不增加 OpenClaw key 解析，也不修改 OpenClaw core。

## RED → GREEN 与验证

真实验收身份和最小文本保存在 `src/http/handlers/fixtures/fork-opaque-session-2026-10-21.json`。新增 4 项分别覆盖 fork/rewind 的逻辑身份映射及映射后仍能阻止运行中任务：修复前 4 失败、18 通过，修复后定向 22 项全部通过。

| 验证 | 结果与范围 |
| --- | --- |
| 插件 unit | 154 文件、1388 项通过 |
| 插件 e2e | 15 文件、43 项通过；显式单 worker，默认并发启动超时另行保留，不算产品断言失败 |
| lint / build / 完整包 | 0 errors、297 项已有 warnings；构建和依赖闭包检查通过 |
| Mac mini 实际 OpenClaw 2026.10.5 | 完整包隔离 21 类检查通过；无真实模型调用，生产配置、SDK、网关进程和长期身份均未变 |
| SDK 会话动作 | 随机 UUID 逻辑 ID → 专属原生会话；fork 200，子会话保留前两条，源会话四条未变；rewind 200，源会话收敛到前两条，切点正文正常返回 |

SDK 台架单独建立会话动作样本，避免将只注册而未实际执行的合成审批运行误当作空闲会话；先前被 busy guard 拒绝的台架尝试单独留存。SDK 台架通过不替代 App 分叉、回退及过渡动画的真机确认。

完整包：`.artifacts/held-releases/2026.10.4-beta.6/deployment/syengup-friday-channel-next-2026.10.4-beta.6.tgz`，1122427 字节，SHA-256 `a1f148e41ea581756408bcfb6d62b5e1672d3fc542dc9cdb9f30a82a3525028d`。相邻 `manifest.json` 保存源码摘要、测试和授权状态。私有证据通过 `/tmp/friday-p5-remaining-root.txt` 定位到 `fork/`，不将真实凭证、历史正文或用户数据提交进仓库。

## 后续关卡

用户选择“安装 App 并部署 beta.6，不发布 npm”后，脚本在实际 Mac mini 重复通过 21 类 SDK 检查，再执行托管停止、完整快照、官方 archive 安装和启动。部署 ID `20261021T095532Z-8fd20326`，状态 deployed，生产由 beta.5 更新为 beta.6。备份目录权限 0700，含旧代码与依赖、频道数据、配置、SDK SQLite 和六个 Agent SQLite；回滚入口为 `./scripts/deploy-gateway.sh --rollback 20261021T095532Z-8fd20326`，保留当前用户数据。

部署前后 serverInstanceId、gatewayFingerprint 与 canonical 能力保持；账本 server.json、TLS 私钥和完整链、域名及分配身份五个文件均与备份字节一致，插件 frpc 仅一个实例。手机同步原位安装已通过 71 项回归的定时正文修复版，安装前设备数据单独留存。

用户从原 A2 再分叉，没有重发 A1/A2，确认原会话 A1/A2、新会话 A1/B、唯一回复与重进均正常。后台原会话 4 条消息的 id/role/text 完全不变，子会话精确保留 A1 的 2 条前缀；B 请求只有一个运行 `c02391e7-bed1-43c8-b195-283cd47143e4`，completed、17 帧，最终回复唯一。

随后用户在子会话回退到 B，确认旧回合消失、正文回到草稿，再改发 P5-REWIND-1021，回退、草稿和两边重进正常。后台新运行 `4c49cd8c-388c-49c6-901d-d8d16239406d` 只有一条请求、15 帧、唯一回复；原会话仍逐身份／正文不变，子会话活动历史为 A1 两条加新回合两条，不再包含旧 B。旧运行审计记录保留，不能将其存在解释为回退后消息复活。

结果在 App `.artifacts/device-acceptance/20261021-fork/`，固定产物 manifest 同步为已部署且真机确认。npm 未发布 beta.6。总进度见 [P5 非语音验收](../../../Friday/docs/reviews/channel-kit-p5-nonvoice-2026-10-21.md)。
