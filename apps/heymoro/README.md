# Heymoro · Payload 工程

**当前使用持续本地开发入口（2026-11-17）**。在已安装依赖与指定 Node 版本下执行 `pnpm --filter @heymoro/server dev:local`，后台位于 `http://127.0.0.1:3001/admin/templates`。

- 模板为单份当前配置，普通保存／上下架；已上架保存影响后续新生成，已提交任务沿用原快照。目录、会话、受理、worker 与客户端已移除业务版本协议。
- 效果展示关联管理员发布的既有会话分享；不再单独上传示例原图／效果图。管理入口在“会话分享”，只选已有成品、确认可公开、生成链接并关联模板。普通用户和运营角色不获得发布权限。
- 分享不调用模型、不复制媒体、不扣点；只读视图不返回原图、私有输入或内部 Prompt。撤销同时阻止元信息／封面／成品继续读取，后续生成不会自动公开。
- 开发身份由正式本地入口签发正常后端会话，复用用户、积分、上传与草稿，不在前端注入 token。生产拒绝开发目录。首次开发账号 `admin / 123456`，已有账号不重置。
- 当前本地配置 `image:null`：可浏览、上传和保存草稿；生成明确提示未配置且不扣积分。测试替身不代表真实 OpenAI 出图，后续需配置模型。
- 存量本地数据保留；新增分享授权表不重建用户或图片。生产部署、真实支付、手机软键盘与已知 libsql 原生稳定性仍需独立验收。

配置、SQLite 和图片保留在工程外专用目录，停止入口不清数据，也不设置自动关闭计时。实际范围与历史证据见[工程验证说明](docs/verification.md)；产品与 Figma 唯一入口如下。

## 资料与目录边界

- [产品资料唯一入口](https://github.com/Heymoro/product-lab/blob/main/products/heymoro/README.md)：PRD、Figma、技术方案、评审 DDL 与类图集中在私有 `product-lab`，本工程不保留副本。
- `src/`：既有应用实现；`scripts/`：工程命令；`tests/`：测试与隔离实验。
- [验证操作与历史记录](docs/verification.md)：命令影响、隔离方式、历史结果与未验收项。
- [历史后台权限边界（已归档）](docs/admin-access.md)：现有管理员／运营／业务用户的职责与待人工验证项。
- `test/_community` 是上游测试入口，单向引用应用源码；不作为产品服务启动器。
- 本仓为公开仓库。提交前检查资料、测试账号、运行数据与日志；团队方案只进入私有资料库。当前未提交的应用文件不等于 GitHub 已发布代码。

## 运行前提

命令在 **Payload 仓库根目录**执行。依赖复用本仓 workspace，不另装 starter。

- Node 版本以 `packages/payload/package.json` 的 `engines` 为准，目前要求 **>=24.22.1**。
- pnpm 版本以根 `package.json` 的 `packageManager` 为准，目前为 **11.28.6**。
- 本地实施使用独立缓存的 Node **24.22.1**（官方包 SHA-256 已核对），不替换系统 Node；默认 shell 的 24.20.0 仍不满足要求。运行前显式选择正确 PATH。
- 正式配置只接受工程目录外的显式绝对JSON路径 `HEYMORO_CORE_CONFIG_FILE`；不回退旧 `DATABASE_URL`、上传目录或mock身份。缺配置时先于数据库连接拒绝。
- `identity`政策必填：显式Session TTL、trial及WeChat配置，不隐含7天或2点。`trial:null`暂停新发款，`wechat:null`只暂停新换码登录，已有正常会话的读取／昵称／撤销服务仍可用；配置结构以实际validator为准。
- 目标库必须先通过显式初始化生成schema-ready标记；仅 `NODE_ENV=development`／`test` 可创建全新目标目录。正常启动只打开已识别目标，不自动建表、修复或迁移旧库。schema-ready仅表示数据库结构就绪，不代表HTTP、模型或产品验收完成。
- Next开发入口仍默认 `http://127.0.0.1:3001`、后台 `/admin`。E0R已在明确隔离副本／新目标／随机环回端口验证正式健康接口与冷进程重启；不代表默认命令不会发现环境文件，仍不要用旧环境或旧库做联调。
- 图片AI适配依赖同级私有本地包`../ai-engine`；先在该包执行`pnpm install --ignore-scripts`、`pnpm build`，再在Payload根执行安装以刷新file依赖。没有postinstall隐式构建；包只在本地Git维护，尚未配置远端。
- `.env.local`、`.data/`、外部宿主JSON、上传文件和日志不是交付资料；密钥只放私有配置，不进入源码或验证记录。

## 命令影响

先确认目标环境和数据归属，再按需执行。此表是命令影响说明，不是可无差别批量执行的清单；测试优先使用隔离数据与显式配置。

| 命令（仓库根目录）                                                                                                                                  | 用途与影响                                                                                                                                                                                                                                                              |
| --------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm product:test`                                                                                                                                 | 现有单元／边界测试；包含模拟数据和临时文件，不等于接口、真机或真实模型验收                                                                                                                                                                                              |
| `pnpm exec vitest run --config apps/heymoro/tests/creation/vitest.config.ts`                                                                        | 新版隔离集成；自建临时库／环回Redis，含S3／MinIO用例可启动本机Docker临时容器，明确禁环境文件发现。正式runtime测试必须清除PAYLOAD_DROP_DATABASE／PAYLOAD_MIGRATING；原28文件最新完整复验失败及新增专项边界见验证说明，不把单次Native门禁当整体验收                       |
| `node apps/heymoro/tests/creation/next-http-spike.mjs --verify-existing /ABS/OWNED_VALIDATION_DIR`                                                  | 本轮Mac隔离验收专用，须指定Node24.22.1及已有passed目录／工程外受控基线；独立ledger重验ready目标与两次真实Next健康请求，不复制、安装或初始化。不是通用dev命令；缺归属证据、空间或隔离条件即拒绝                                                                          |
| `pnpm product:typecheck`                                                                                                                            | 先生成框架声明及构建缓存，再检查应用；并非完全只读                                                                                                                                                                                                                      |
| `NODE_ENV=development pnpm --filter @heymoro/server core:init --config /ABS/core.json`                                                              | 显式创建配置指定的全新目标目录和SQLite结构；已有目录拒绝，不适用于生产初始化。JSON须在工程目录外，含明确密钥／预算／目的地；不要使用旧库路径                                                                                                                            |
| `pnpm --filter @heymoro/server admin:command --config /ABS/core.json --command /ABS/command.json`                                                   | 仅对正式ready目标执行宿主bootstrap／create／update，写Native管理员及审计；不初始化／迁移或开放HTTP。配置与命令均为工程外私有JSON，口令／JWT不放argv／环境；create／update须已有active管理员NativeJWT。unknown先核对，不自动重放；已确认但cleanup失败仍保留confirmed结果 |
| `pnpm --filter @heymoro/server generation:reconcile --config /ABS/core.json --command /ABS/reconcile.json`                                          | 对正式ready目标只读核查，或显式恢复／人工未交付关闭；后两者可能登记交付并capture或release积分。两个文件均为工程外私有JSON；JWT仅置命令JSON，不放argv或环境。不开库初始化／迁移，不触发模型或新attempt；本片只验源码，真实目标运行另批                                   |
| `pnpm --filter @heymoro/server generate:types`                                                                                                      | 更新本应用生成的类型源码                                                                                                                                                                                                                                                |
| `pnpm --filter @heymoro/server generate:importmap`                                                                                                  | 更新后台生成的 import map                                                                                                                                                                                                                                               |
| `pnpm product:dev`                                                                                                                                  | Next开发入口；需明确JSON及已识别目标，会写业务数据。所选业务HTTP已有受控Next证据，未覆盖全部端点；默认入口的环境发现隔离未验，不作为核心闭环验收命令                                                                                                                    |
| `setup:local`、`test:creation-http`、`test:admin-http`、`test:http`、`test:mvp-http`、`test:unified-spike`、`dev:creation-fixture`（原应用scripts） | 已退役：七个别名已从package scripts移除，不是当前可执行入口；旧源码仅留作历史，不作为操作建议，也不以新别名恢复。原辅助脚本可能读环境、写库、复制应用或启动Next，不适用于正式运行档                                                                                     |
| `HEYMORO_CORE_CONFIG_FILE=/ABS/core.json pnpm --filter @heymoro/server jobs:creation`                                                               | 直接加载正式builder，有界执行creation／creation-naming两队列并关闭自有资源；不走Payload CLI环境加载器，可能产生真实模型费用及业务写入，不是测试命令                                                                                                                     |
| `pnpm --filter @heymoro/server build:check`                                                                                                         | 类型及 compile 模式检查；不等于完整生产构建或部署验收                                                                                                                                                                                                                   |
| `pnpm product:build`                                                                                                                                | 使用实际配置完整构建；可能访问数据库，需另行确认环境与生产校验                                                                                                                                                                                                          |

隔离实验、重启验证、首次启动步骤及清理范围见 [验证说明](docs/verification.md)。不要用框架测试启动器、清库参数或未经检查的环境操作开发数据。

## 当前接线边界

下面区分当前运行入口与后续工作；旧源码保留不代表其端点仍可用。

| 范围     | 当前实现                                                                                                        | 尚待验证／接线                                                        |
| -------- | --------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| 账号     | 原生管理员与opaque业务会话分离；正式身份服务处理验证换码、共享认证、本人昵称与幂等撤销；宿主CLI管理Native管理员 | 其余真实Next／真实微信登录及客户端真机；头像授权保持独立可选          |
| 模板     | 目录、草稿、发布、管理读取和分类／标签服务、Native-cookie官方示例上传；原生管理表单已有源码                     | 表单真实Next／浏览器验收、大图私有存储链；其余端点／客户端真机        |
| 积分     | SQLite账户／批次／预留／分摊／流水及结算；首次trial由固定来源与key确保，原发款按原参数重放                      | 其余真实Next／客户端验收；支付、订阅及积分包购买不在本轮核心范围      |
| 生成     | 正式双Native jobs使用同实例worker／命名服务，自动消费及自动重试关闭                                             | 其余实际Next／微信真机与真实模型质量；旧生成端点已退出默认配置        |
| 数据结构 | Native schema驱动新目标初始化，ready目标只读预检后打开                                                          | 现有数据不迁移；私有通用DDL是评审模型，不是手写执行的Native migration |

宿主显式将图片执行／报价配置设为null时不可生成，不自动选择付费模型。测试PNG不代表AI效果；`unknown` 保留占用，不因重新执行队列而自动重发收费请求。不要直接改状态、余额或数据库来补造成功。

后续实施须引用明确确认的原型、PRD 和技术方案版本；工程检查、真实模型结果、微信真机交互及生产验证分别记录。

### 生成核查命令合同

命令 JSON 必填 `action`、`authorization`（`JWT TOKEN`）、正整数 `taskId`。`inspect` 可附 `operationId`，只读数据库完整事实，不查存储或触发恢复；`recover` 必填当前 `attemptId`，只复用原可信输出恢复，绝不重发模型请求。`close-undelivered` 还必填当前 `attemptId`、唯一 `operationId` 和 `confirmedUndelivered:true`，原因固定为 `PROVIDER_UNRESOLVED`；不接受 actor／reason／用户ID／存储地址。

关闭前在事务与Redis锁外按任务原始输出目的地查证：完整唯一对象优先恢复，完整零对象才按管理员明确决定关闭；不完整、多对象、异常及已有输出事实未证实均不等于未交付。S3和数据库没有分布式原子“不存在”保证；关闭后迟到对象沿原政策只留私有证据，不免费交付或反转终态。

输出为单行脱敏JSON；`pending`仍是未知，不等于provider失败。已关闭重试返回 `originalOperationId` 和实际返可用／到期数量，不假称新操作已执行；operation冲突（含墓碑）拒绝。`unknown`不得自动重放或换operationId；先核对完整审计和资金事实。已确认但清理失败保留 `confirmed`，附 `cleanupCode` 并非零退出，明确不要重放。没有自动时限关闭、运营扩权或新增成本承担政策。
