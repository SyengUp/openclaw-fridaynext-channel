# OpenClaw 2026.10.5 标准停止桥兼容修复

本专项来自 FridayNext 真机 P5。用户确认停止可用，并已确认客户端“思考圆点 → 步数胶囊”动画修复正常；服务端原始记录却仍有停止后的宿主 no-visible-reply 兜底正文。独立的 OpenClaw 适配桥修复已按用户“先部署，不发布”的要求更新生产为 beta.3，真实停止及动画样本通过，约 20 秒的停止延迟继续调查；没有发布 npm。

## 根因与变更

在实际网关的官方 OpenClaw 2026.10.5 dist 中，旧 `abortSessionRunTargetWithOutcome` 已不存在；标准停止变为 `prepareSessionRunTargetAbort(params)` 返回提交函数。旧桥只匹配旧函数名，因此返回 null，调用方退回普通 harness abort；执行虽然停止，reply operation 未进入正常用户取消的 SILENT 分支，宿主随后发出兜底错误。

`src/agent/session-abort-bridge.ts` 继续支持旧直接入口，并把新准备函数适配为“准备并提交一次”。参数与归一化返回值保持原来的窄接口，retirement 仍异步收尾。共享 Kit、客户端协议和 OpenClaw core 均未修改。

新增失败测试使用实际新版 SDK 的导出和调用形状，旧实现定位结果为 null；修复后能调用标准入口，且提交计数为一次。真实 SDK 隔离脚本新增强制门槛：标准停止入口必须可定位、可调用，空闲目标返回非活跃且未中止，避免宿主改名后悄然回退。

unit 配置改用 `fileURLToPath(import.meta.url)` 定位目录，使 ESM runner 与原 bundle loader 均可使用；该项仅为验证配置，不进入生产包。

## 验证

| 验证 | 结果 |
| --- | --- |
| 停止桥定向测试 | 15 项通过；现代入口先 RED，再 GREEN；旧直接入口及无桥回退保留 |
| 插件 unit | 完整 2026.10.5 SDK 镜像下 151 个文件、1359 项通过 |
| 插件 e2e | 同一 SDK 镜像下 15 个文件、43 项通过 |
| 构建与 lint | 构建通过；0 errors、297 条既有 warnings |
| 官方 SDK 原生 archive 安装 | 同宿主 2026.10.5、Node 26.4.0 的独立 loopback 状态，16 类检查通过，modelCalls=false |
| 匿名 npm 安装 | 空缓存安装 registry tgz 自动获取 Kit 0.1.2，未安装 OpenClaw SDK |
| 候选与生产包比较 | 无新增或删除文件；功能变化限于停止桥及版本信息。历史 normalizer 的两份差异为注释，公共依赖内容相同 |

本机没有全局 OpenClaw 安装。初始仅用空 dist 占位跑定向注入测试；完整回归使用从网关只读复制的官方 dist 及实际依赖，最终结果来自 ESM config loader runner，未将缺依赖的初始运行计为通过。SDK 镜像和临时工具不进入仓库或生产包。

原生隔离回执：`.artifacts/deploy/20261020T164906Z-a71753fb/verify-result.json`。它验证标准入口绑定和空闲目标，不代替部署后的真实模型取消回合；还需在实际派发操作中确认不再生成宿主兜底事件。

## 产物与生产部署

生产插件 `2026.10.4-beta.3`，Kit 继续精确固定为 npm `0.1.2`。

- 完整部署包：`.artifacts/held-releases/2026.10.4-beta.3/deployment/syengup-friday-channel-next-2026.10.4-beta.3.tgz`，SHA-256 `eae906d6013da41ec7ea025b74883c297edfb41ac5f9d15abaac1073ce87f27a`。
- registry 包：同目录的 `registry/syengup-friday-channel-next-2026.10.4-beta.3.tgz`，SHA-256 `9ea8d7b68fc5dfcde8328108e4a0b7eaaae7525dfc179109e0b7667a0a9101d8`。
- 生产通过 SDK 官方 archive 安装由 beta.2 更新为 beta.3，安装路径仍为 `/Users/syengup/.openclaw/extensions/friday-next`；未发布 npm、未提交源码。App 沿用已确认动画修复的真机二进制，无需重装。

部署操作 ID 为 `20261020T165928Z-86f88259`，回执位于 `.artifacts/deploy/20261020T165928Z-86f88259/`。固定摘要完整包在同宿主 OpenClaw `2026.10.5`、Node `26.4.0` 上再次通过 16 类隔离检查，再由 [完整包事务脚本](../operations/gateway-full-package-deployment.md) 执行托管停止、备份、官方安装和启动；生产回执状态为 `deployed`，安装时间为 `2026-10-20T17:00:18.594Z`。

完整备份位于网关 `/Users/syengup/.openclaw-deploy-backups/friday-next/20261020T165928Z-86f88259/`，含实际代码与依赖、频道数据、配置、SDK SQLite 及六个 Agent SQLite。回退保留当前用户数据：

```bash
./scripts/deploy-gateway.sh --rollback 20261020T165928Z-86f88259
```

部署后健康检查与权威安装索引一致：插件 beta.3、Kit 0.1.2、来源 archive；canonical 能力和宿主声明面保持不变。服务实例身份、网关指纹以及账本／TLS／公网分配五个文件摘要均与部署前一致；本插件 frpc 仍为一个实例，个人 frpc 保留。部署私有证据根为 `/var/folders/nc/l06s87s51v53lmjw2h8wlq000000gn/T/friday-beta3-deploy-zhw1y353/`。

真实停止复验 `P5-STOP-B3-1021` 已收讫：用户确认停止、动画及重新进入均正常；手机和网关均为原请求、一个运行和 cancelled 终态，16 帧原始事件没有 deliver.final 或失败事件，宿主兜底正文已消失。首个停止样本在服务端延迟 20043 毫秒，同窗口宿主事件循环延迟；随后用户连续三次复验均及时停止，账本耗时分别为 57、33、43 毫秒，各自单次执行、无兜底或失败事件。常规重复停止样本通过；首次阻塞根因仍按 [停止延迟调查](openclaw-stop-latency-2026-10-21.md) 保留待复现，不能据此关闭取消全量和 P5 其他公网、系统通知、Talk 等关卡。

本次私有证据根：`/var/folders/nc/l06s87s51v53lmjw2h8wlq000000gn/T/friday-stop-compat-1021-3nqa5vky/`。完整候选及测试摘要另保存在相邻 `manifest.json`，未依赖临时目录作为唯一恢复点。
