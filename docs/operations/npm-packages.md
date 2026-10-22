# npm 公共库与插件分发

Kit 的公开包名为 `@syengup/fridaynext-channel-kit`，当前固定版本 `0.1.3`。插件在 `dependencies` 中使用精确 npm 版本，锁文件固定 registry 完整性；源码及安装链路不再依赖 `vendor/` tarball 或兄弟仓库。

2026-10-22：Kit 0.1.3 已发布，匿名空缓存安装核对 100 个文件及 40 项运行合同通过；匿名安装插件包会自动拉取该固定版本。beta.8 完整包已通过实际 OpenClaw 2026.10.5 验证并部署，插件未发 npm。首次 npm 503 阻塞、恢复、固定产物和回滚见 [发布部署回执](../reviews/tunnel-health-kit-release-2026-10-22.md)。

## 两种插件产物

| 用途 | 命令 | 依赖处理 |
| --- | --- | --- |
| npm 发布包 | `pnpm package:registry --pack-destination <目录>` | 只携带插件自身；安装时 npm 下载固定 Kit 及其依赖 |
| 网关离线部署包 | `pnpm package:pack <目录>` | 构建时从 registry 安装并内嵌全部生产依赖；目标网关无需联网安装 |

两种产物都不包含 OpenClaw SDK。输出目录应分开，避免同名 tgz 相互覆盖。网关部署脚本要求所有生产依赖已内嵌，会在停止服务前拒绝 registry 发布包。部署说明见 [完整包部署与回滚](gateway-full-package-deployment.md)。

## 发布顺序

先在 Kit 仓库执行构建、合同测试、独立目录测试并打包：

```bash
pnpm test
node scripts/verify-independent.mjs
pnpm pack --pack-destination /tmp/friday-kit-release
```

经用户明确要求发布时，对这份固定 tgz 执行 `npm publish --ignore-scripts --access public --tag latest --registry https://registry.npmjs.org/`。npm 可能在返回发布成功后继续处理包；此时版本查询或匿名安装仍会暂时返回 404。需要等真实 registry 安装成功、SRI 与本地 tarball 相同，再推进依赖它的插件发布，不根据一行发布成功回执跳过验证。

Kit 可安装后，在插件仓库更新精确版本与锁文件，执行插件测试，分别验证正常 npm 安装和完整部署包。插件发布需要使用未发布的新版本号，并另外获得用户明确要求；Kit 发布不会自动发布插件或重启生产网关。

## 安装验证

验证在全新临时目录执行，使用空缓存、匿名 npm 配置、官方 registry；检查锁文件的 `resolved` 与 `integrity`，再从安装包加载 `ChannelService` 并运行合同测试。该目录不包含 OpenClaw，也不检出适配器仓库。

registry 插件包还需验证：tar 中没有 `vendor/` 或内嵌 Kit，`npm install <插件 tgz>` 会从 registry 下载 Kit；完整部署包则要求 Kit、`qrcode-terminal` 及所有传递依赖真实存在。发布和部署以最终固定 tgz 的 SHA 为准。

## 2026-10-20 发布记录

`@syengup/fridaynext-channel-kit@0.1.2` 已公开可安装，`latest` 指向 `0.1.2`。其 SRI 为 `sha512-uRqc4n1yz4eIVPrbFo0B5RZB9+jGE05PyayItyw4JcvaUxmF4tXbQmFNbM0DgwgsG8VEWLvyKvx1L/TxGchoQw==`。

Kit 本地及无宿主独立目录各通过 37 项测试；匿名空缓存下载的 registry 产物通过 36 项运行合同，额外的源码架构检查保留在源仓运行。registry 产物的 96 个编译文件与现有部署的 Kit 一致。

插件发布包已在匿名空缓存目录真实安装，Kit 由 registry 提供并被 npm 提升到项目级 `node_modules`；验证脚本已用标准包解析支持该布局及完整包内嵌布局，两者不再依赖固定子目录。正常安装包在现有本地官方 OpenClaw `2026.10.1` 隔离环境通过 15 类 SDK 检查；完整离线包在无 SDK、无兄弟仓库环境可加载 Kit 与全部背书依赖。前一阶段的生产 OpenClaw `2026.10.5` 部署保持不变。

上述为 Kit 首次发布阶段的记录，当时没有另发插件版本。后续用户已授权发布插件 beta 并更新网关。

## 插件 beta 2026.10.4-beta.1

插件 `@syengup/friday-channel-next@2026.10.4-beta.1` 已通过 beta 标签公开发布，latest 保持 `2026.10.3`。SRI 为 `sha512-XMMi52fUlA39BVm+kjgaTid1e/YhgC7a7LLs8i+Ys0ZuN9WuoVd5dPnIHyjU1lhVjPpo4zSzfjp/AXGrAX7YeQ==`。

匿名空缓存直接执行 `npm install @syengup/friday-channel-next@2026.10.4-beta.1`，插件和 Kit 均从官方 registry 下载，Kit 固定为 `0.1.2`，不依赖本地 tarball。OpenClaw `2026.10.5` 的原生 npm 安装及 15 类运行检查通过；实际生产旧版本 `2026.10.3` 的完整快照也已在隔离状态通过 SDK 回装验证。

SDK 更新和回滚故障台架为 27 项，包含安装路径变化、完整依赖回装、未知结果后的回退，以及关闭／活跃 WAL 的只读读取。插件单测 1354 项、端到端 43 项通过；lint 为 0 errors、297 条既有 warnings。生产部署回执由 [完整包部署手册](gateway-full-package-deployment.md) 记录。
