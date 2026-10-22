# Kit 探活修复发布与网关验收

2026-10-22。Kit `0.1.3` 已发布到 npm，插件 `2026.10.4-beta.8` 已按授权完整部署到 Mac mini，插件未发布 npm。匿名安装与真实 SDK 验证通过，生产稳定观察和用户真机复验均通过。本专项关闭；整体 P5 和延期的 Talk 不因此关闭。

## 修复归属

Kit 的看门狗以 HEAD 请求只接受 GET 的旧健康门面，收到 405 后累计失败，并误重启 frpc。真实设备 SSE 断开与网关主动重启的时间一致。修复归 Kit 公共隧道模块，插件只更新固定依赖和版本，不增加另一份探活实现。根因、真实数据和 RED→GREEN 见 [Kit 专项](../../../fridaynext-channel-kit/docs/reviews/tunnel-health-method-2026-10-22.md)。App 的首页预取优化已通过用户约 1 秒内显示的确认，不需要为本次服务端修复重装 App。

## 已完成验证

| 项目 | 结果 |
| --- | --- |
| Kit 源码／独立目录 | 各 41 项通过，0 失败、0 跳过 |
| 插件候选 | 固定本地 Kit 0.1.3 归档；1392 unit、43 e2e 通过 |
| 编译与 lint | 编译通过；0 errors、297 条既有 warnings |
| 部署故障台架 | 31 项通过 |
| 真实 SDK | 实际 Mac mini 的 OpenClaw 2026.10.5，SDK 正式 archive 安装，22 类检查通过，未调用模型 |
| 健康门面方法 | 真实隔离插件：无凭证 GET 401、HEAD 405；验证器新增断言通过 |
| registry 匿名安装 | Kit 100 个文件与固定归档一致，40 项运行契约通过；匿名安装插件包自动拉取 Kit 0.1.3 |
| 最终完整包 | 从 registry 正常生成；350 个编译文件与回归候选一致，再于实际网关重复通过 22 类 SDK 检查 |
| 生产与真机 | 实装 Kit 100 文件、5 项长期身份一致；255 秒无探活失败或 frpc 重启；用户确认连接、模型和侧栏均正常 |

本地 unit／e2e 的宿主别名沿用本机 2026.10.1 SDK；2026.10.5 行为另由实际网关机的全新 loopback 状态核验。隔离目录初次因包管理器自动对账及未指定 SDK 路径而未能启动的记录单独留存，不计为产品 RED；改用固定依赖和显式 SDK 后完成上述验证。

首次 SDK 隔离操作 ID 为 `20261022T030431Z-f1e554e0`。测试完整包 SHA-256 为 `6c86aa33c007e74a2fbf69d28d40846bbc5c1067ed4c87e8a5d5b286261ad1ae`，只用于发布前隔离验证；它从上一固定完整包保留未变的传递依赖，再替换经过验证的插件编译文件与固定 Kit 候选。随后最终生产包已由正常打包器从 registry 生成，并重新通过实际网关机的隔离关卡。

Kit 发布固定包 SHA-256 为 `8182ca893dc32aa5d2e619a8d9ebc1bbad2459a4976e1aaf15125834d3f31ce1`。候选、发布元数据、测试日志与 SDK 回执保存在 `.artifacts/held-releases/2026.10.4-beta.8/`。npm 阻塞期间曾恢复原发布元数据以保留可安装基线；恢复后已将版本、固定依赖、年龄白名单及锁文件正式更新到 beta.8／Kit 0.1.3，其他锁定依赖不变。最终 registry 依赖另有 38 项定向回归通过。

## 首次 npm 阻塞与发布恢复

首次发布命令经过 npm 客户端重试，最终返回 `E503 Service Unavailable`；后续有限重试超时，当时没有可下载版本。[npm 官方事件](https://status.npmjs.org/incidents/xfp75s9j3bp8) 报告北京时间 10:33 起安装和发布服务故障。此阶段没有部署。

再次检查时，默认凭证的发布请求返回 404；随后使用已保存发布凭证的临时私有配置取得 Kit 成功回执，未改动全局 npm 配置，临时配置已删除。没有改用镜像或消耗恢复码。收到回执后还等待 registry 处理和匿名安装成功，才推进插件；没有把账号查询成功或一行发布回执等同于可安装。

Kit `latest` 现为 0.1.3，SRI 为 `sha512-Q8RslJOE65+Jc3c6SLAvTYELIzPHb0aUUt1k6UkrpGW778XAOxndownGZeqn4LoN2qtdWrJOjLUvBTa9DVdf2w==`。本次发布／安装链路已实测可用，不据此声称 npm 官方故障已全面关闭。插件 beta.8 未发布 npm。

## 最终部署与回滚

沿用原明确授权，完成以下关卡：

1. 对固定 Kit 归档取得发布回执，等同版本可下载，再核对 SRI，没有另起版本掩盖未知结果。
2. 匿名空缓存安装验证包文件、registry resolved／integrity 和运行合同；匿名安装插件包确认自动下载 Kit。
3. 更新 beta.8 与 Kit 0.1.3 精确依赖及锁文件；没有使用 file、link 或兄弟源码。
4. 从 registry 生成最终完整包，同宿主验证成功后执行备份、SDK archive 安装和托管启动。
5. 生产实际加载 beta.8／Kit 0.1.3，原 serverInstanceId、gatewayFingerprint、TLS 与公网分配连续；唯一插件 frpc 在 255 秒观察中 PID 不变，日志没有探活失败或重启。用户随后确认连接稳定，模型名称及侧栏定时任务／收件箱均正常。

生产操作 ID `20261022T033723Z-5ad4bd0d`，状态 `deployed`。最终完整包 1126249 字节，SHA-256 `d94e98b3381bffa3e385516ce7be06a2bbd3d2fc3a3994cd24052be1b06c8267`；其 350 个编译文件与回归候选相同。备份在 `~/.openclaw-deploy-backups/friday-next/20261022T033723Z-5ad4bd0d/`，权限 0700，包含原代码和依赖、频道数据、配置及数据库一致性快照。回滚保留当前用户数据：

```bash
./scripts/deploy-gateway.sh --rollback 20261022T033723Z-5ad4bd0d
```

首次附加只读检查未解析 SDK SecretRef，产生的 401 仅属于检查脚本；补齐与部署器相同的只读解析后，生产 canonical health 为 200，身份及能力检查通过。没有修改生产凭证或放宽鉴权。

私有原始数据从 `/tmp/friday-tunnel-coldstart-root.txt` 指向的 `iteration-3-tunnel-health/` 读取。无需重装 App，本轮未提交或推送代码；用户设备确认已记录，后续 P5 仍按原清单继续。
