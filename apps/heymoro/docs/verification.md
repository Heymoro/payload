# Heymoro · 工程验证说明

[← 工程入口](../README.md)

当前进入本地分阶段实施；本文件区分当前复验与既有历史。命令存在、旧记录通过和新功能验收是三件不同的事；未明确登记的能力仍待验证。生产部署、存量迁移与真实支付不在本轮范围。

## 当前模板与会话分享（2026-11-17）

- 现行闭环：普通创作 → 已有会话与成品 → 管理员明确选定成品发布分享 → 模板关联 key → 匿名只读会话；“做同款”仅带模板身份，复用原创作器，不复制原图或私有输入。删除独立效果示例上传／原图对照图库与业务版本管理，保留可选封面。模板未关联分享也可以保存上架。
- 服务只增加一份私有分享授权，不调用模型、不复制 S3 对象、不改原任务或结算。发布／更新／撤销均在 Native Cookie、active admin 和事务内再次鉴权下执行；operator／user／Bearer 不获得权限。所选成品固定，后续生成不自动公开；已发布较早选择在新结果增多后仍保留。
- 单元与真实 Payload／SQLite／Redis／环回 S3 验证覆盖：公开 DTO 白名单、跨会话／原图拒绝、未选中成品拒绝、Native 登录与 CSRF、角色降权、并发幂等、审计回滚、读取中撤销／任务软删、撤销后旧链接失效、重新发布换 key，以及模板关联和目录批量滤除撤销分享。生成环节为受控图片替身，没有付费调用。
- **主仓当前复验**：Node 1130 全部通过、应用 no-emit 通过；完整 Native 首次进程出现既有原生 SIGSEGV，729 passed／10 实际 pending，退出 1，失败报告保留。降低并行运行服务后，在新目标完整复验 739/739、零失败／pending、退出 0。逐项检查 assertion 状态，不相信单一顶层 success。此通过不代表 libsql 间歇性根因已修复。
- **实际 Next 页面**：日常入口健康 200；模板编辑仅保留封面上传与会话关联，无独立示例上传／版本控件。会话列表与无可分享成品状态、发布禁用、读取反馈聚焦、1280px 无页面横向溢出已检查；无效公开链接及图片接口返回 404。日常尚无模型生成产物，不把空列表当真实出图成功。
- **客户端**：2328 项记录，2326 passed／0 failed／2 既有 HTTP skipped；src lint 通过；固定 Node 24.22.1 微信编译通过，输出专用本地项目。未重新扫码，未把编译当手机／软键盘验收。
- **存量保护**：通过新 Native 目标增加分享表，40 张原表全部逐行保留，旧目录保留可回退；私有配置未改。此前 24 份受保护失败数据库／WAL／SHM 仅做字节 SHA 核对，零变化，不 SQL 打开。没有重置用户、积分、原媒体或草稿。
- **界面证据边界**：检查 native label／fieldset／table 语义、读取反馈与焦点（WCAG 1.3.1、2.4.3、4.1.2／3）和桌面重排（1.4.10）；未做完整键盘、增强对比、读屏／axe 或全 AA 审计，不声明整体合规。真实 OpenAI 配置、真机与原生稳定性仍需独立验收。

以下日期章节为历史验证，不作为当前版本／图库功能的说明。

## 单份当前模板持久化（2026-11-16）

用户已明确确认：已上架模板保存后立即对后续新生成生效，旧任务仍使用原快照。新增当前模板service／Collection／repo，只有一份当前配置及保存／上下架，不复制草稿或历史版本。此模型仅注册在新的Native隔离目标，未替换日常组合根或迁移数据。

- 实际SQLite／独占Redis9项通过：同一行创建、保存、上下架与已上架保存仍published；标准审计／软删字段、普通索引且无业务FK／UNIQUE／版本列；并发编码查重只留一行；权限／坏配置／无效引用／审计失败拒绝或回滚；22条真实分页与搜索、私有配置不进入列表摘要、accessor与额外版本字段拒绝。示例使用受控DB回执fixture，不声称真实S3对象可达性，也未调用模型。
- 两次早期失败分别暴露了旧通用runtime对legacy集合的硬依赖，以及Native create传空originalDoc导致误判更新。新repo固定验证所需四集合hook并使用同req/gate与现有UOW；旧核心guard未降级。Collection只在update校验code／kind不可改，保留Native create及审计事务。原失败日志和目标保留，不重放旧失败数据求通过。
- 根完整Node1210通过；同一最终源码完整Native32文件776项全部passed，零失败／跳过，退出0，128.01秒。检查逐项状态，不只看JSON顶层success。应用类型、6文件默认lint／7文件格式与独立规格／质量审查通过。Native隔离清单只加一行，原严格匹配与envDir／无setup／单worker保留。独立新Native类型图仍有51项跨依赖诊断，新目标两文件无诊断，不表述为整图类型通过。
- 日常3001仍健康、原数据／配置未切换。此次没有SIGSEGV，不代表间歇性原生问题根因已修；旧失败库保持。正式目录、会话、报价、worker／成品证据、后台及Taro仍须完成去版本接线，不能把新fixture当成完整产品。

## 当前模板编译切片（2026-11-16）

新增纯领域编译器`current-template.ts`，直接接收单份当前配置，不含业务版本身份；复用既有公开配置与通用执行解析。公开DTO不含内部Prompt／执行器／配置摘要，私有执行事实独立复制并深冻结。服务端摘要覆盖模板身份、价格、mode、有效输入限制与编译后模型／Prompt／参数／存储目的地；JSON键序、MIME集合顺序及纯展示变化不造成执行授权变化。

- 初始6项RED后实现，最终9项专项及完整Node1210项通过，零失败／跳过；应用类型、3文件默认lint／格式与独立规格／质量审查通过。严格运行源保护保留精确路径与数量，新文件导致的旧计数失败先复现再按新增路径调整，没有削弱保护。
- 尚无运行入口引用此模块，正式报价仍为旧版本协议。没有改当前schema、旧模板、队列任务或日常配置；仅编译切片通过，尚未完成业务版本删除、前后端接线或存量切换。不以单元结果覆盖下节完整Native的原生崩溃。
- managed工作区工具请求未到Git创建阶段；已核对无新增worktree后终止等待，未重复请求。使用现有工程新增未接线模块，不复制依赖或创建替代管理系统。

## 最新回归与持续消费接线（2026-11-16）

- 既有jobs命令新增`--watch`，复用单个Payload实例；持续模式每队列每次1项、单次命令仍最多5项并顺序执行。SIGTERM／SIGINT停止新认领并等待在途任务结束；未启用自动模型重试。local-dev按显式配置持有Next与worker两个自有进程组，任一worker异常退出会关闭配套Next，不留看似健康却不消费的入口。未配置的队列不启动。
- 消费与生命周期专项15项通过，包含真实Node进程组优雅退出；正式Native运行链2项在消费者先运行、任务后受理的条件下，生成／结算／收纳／收藏／幂等及未知不重发通过。正式CLI在新外部配置中image／naming均null时退出0且没有创建data目录，不打开数据库或调用模型。日常用户配置未改，运行中的旧入口保持健康；新启动接线不等于已启用真实模型。
- 最初完整Node1201项为1197通过／4失败，原因是严格隔离策略的源码总数未包含新增消费者；现增加该路径必须恰好出现一次的断言，同步精确总数，未放宽保护。专项61通过后，完整Node1201通过，零失败／跳过。应用类型、7文件默认lint与8文件格式通过；Native大文件原43条旧lint变为40条，无新增诊断，不称该文件全绿。
- **最新完整Native未通过**：31文件共767个用例记录，741通过、26个实际状态为pending，退出1；owner-task-history执行中出现Node原生SIGSEGV。JSON顶层success:true且numPendingTests为0与逐项状态不一致，不据此宣称全绿。已保留崩溃报告及新失败目标三文件字节摘要，不SQL打开／重放失败库；没有升级驱动、采用被推迟的上游分支或重新跑失败数据求通过。后续仅所改运行链在另一新目标复验2项通过，不与741拼接。
- 原生故障补核：崩溃image UUID与当前安装的`@libsql/darwin-arm64@0.4.7`二进制UUID精确相同，定位到该绑定；符号已剥离，不能从偏移推断具体Rust函数。Payload Drizzle destroy只清适配器引用，不关闭client，因此没有证据支持删除应用显式close来“修复重复关闭”。另在全新小目标对当前client0.14.0执行200轮合法deferred事务／commit／close并主动GC，退出0、未复现；不由此宣称绑定稳定或崩溃已修。未升级依赖、构建推迟的上游分支或重放失败库。
- 当前优先事项已改为用户明确取消模板业务版本管理，简化设计见私有实施清单T46。当前源码仍有旧版本模型，尚未删除；不以本轮接线或历史767项通过代替新模型验收。真实OpenAI／微信／物理键盘、原生稳定性与完整交付仍开放。

## 当前后端构建与打包后运行（2026-11-16）

- 固定Node24.22.1／pnpm11.28.6，实际执行应用`build:check`通过，包含框架类型构建、应用类型及Webpack compile；随后完整`pnpm run build`退出0。仍有上游动态require告警，未屏蔽，也未修改框架。
- 使用全新ready测试库、独占Redis及环回HTTP S3fixture，在另一环回端口启动真正的production bundle：Native管理员登录200、后台SSR200、未配置微信503、匿名本人接口401、1,848,097字节官方图片上传201、取图SHA一致。所检查宿主秘密未进入SSR；不是公网部署或真实模型验证，也不将该HTTP存储替身称为MinIO。
- 实测发现生产拒绝开发默认口令返回500。先复现，再将应用hook的普通Error替换为Payload原生AuthenticationError，返回401／公开通用错误。username和email两种生产路径均验证；开发默认口令及强密码行为保留，没有放宽认证。新完整构建后同一类实际HTTP请求已返回401。
- 业务修改后标准Node1189、完整Native31文件767项及应用类型通过；随后仅整理测试断言键序并复验管理员文件29项全部通过，不累加为796。生产源与unit两文件lint／格式通过；Native大文件同一实际路径修改前后均99条旧lint诊断，多重集相同，不宣称该文件lint全绿。规格与质量只读审查通过。
- 构建生成的`next-env.d.ts`两条types导入已按原字节恢复，tsconfig／AGENTS未变。临时进程组为空、端口释放，独占测试依赖已关闭；日常3001健康、目录数据摘要保持，不关闭日常开发服务或迁移其数据。
- 尚需接线：日常入口目前只有API，`jobs:creation`为单次drain，默认autoRun为空；配置模型后仍需持续队列消费。该项按实施清单T45收口，不把“能受理”误当“会自动出图”。真实OpenAI、手机及部署仍未验收。

## 当前完整后端业务集（2026-11-16）

固定 Node24.22.1、单worker、3GiB Node堆，按现有配置完整运行31个Native文件，**767通过、0失败、0跳过，退出0，126.86秒**。没有按路径或名称筛掉用例，也不把多次专项次数相加当作全量结果。

- 首轮同一完整配置为766通过／1失败：隔离SQLite测试的严格文件清单仍停留在28个，遗漏已存在的模板管理、词条和恢复核查三个文件。仅补三行精确路径，不改配置或放宽匹配；单文件25项GREEN后，再完整运行31文件得到上述结果。首轮失败记录保留。
- 本轮覆盖通用生成、Native jobs、受理幂等、原子交付／结算、未知核查、管理员权限复核、模板管理／词条、本人媒体／草稿／收纳／收藏／积分等现有业务。新增恢复核查三项与运行链／结算39项亦已独立通过，但不再累加到767。
- 使用全新测试SQLite、环回Redis／S3替身及现有缓存MinIO专项；模型为typed port或官方SDK的环回fixture，无付费调用。Native路由通过不等于所有外层Next或真机通过。日常后台仍健康，用户数据／配置未被测试重置。
- 原生SIGSEGV本次未出现；驱动和框架未改，不据此宣称间歇性根因已修。独立Native测试类型图的38项旧诊断仍非本轮验收目标。仅改清单的大测试文件默认lint仍非零：同一实际路径的变更前后均190条、诊断多重集相同；没有删规则或把它表述为lint全绿。

## 当前后台界面与键盘修复（2026-11-16）

模板管理按已确认的 shadcn 风格重排，仍使用 Payload 原认证、Server Actions 与发布服务；没有新增组件库依赖或管理 API。列表保持搜索与状态筛选，编辑为基本信息／素材示例／生成设置，桌面右侧集中保存与发布，高级核对按需展开。

- **实际浏览器**：方向键／Home／End、切换后同一输入节点与内容保留、dirty表单内词条搜索、隐藏字段错误自动定位、返回列表清理URL、无匹配搜索及恢复通过。320／390／1200宽度无横向溢出；首字段由原573px上移至340px。
- **真实发布**：新版素材页上传1,848,097字节PNG，保存草稿、检查、明确确认发布、刷新回读通过。修改字段立即作废旧检查；未确认时发布禁用。复古全家福v2发布后只读；匿名目录与详情一致，官方封面原字节SHA吻合，公开DTO不包含内部Prompt。未调用模型。
- **可见性**：实际浅色／深色未选tab文字对比度约6.08／8.03；键盘焦点2px可见，forced-colors与增强对比度下仍可操作。涉及1.3.1、1.4.3／10、2.1.1、2.4.3／7、3.3.1–3及4.1.2／3的部分检查；未做读屏、完整AA审计或真实浏览器200%缩放，不声明整体合规。
- **小程序键盘**：聚焦补充输入后在新布局提交时滚入可视区；旧workflow的focus／blur无权影响新owner，取消仅针对本次notes epoch，不中断后续轮次定位。开发者工具模拟键盘300时输入410.09–450.09完整位于timeline208–479，关闭恢复844，原双图与文字不变；不替代手机软键盘验收。
- **根复验**：后台标准Node1189通过、零失败跳过；应用no-emit、默认lint、CSS与格式检查通过。前端2311通过、零失败、2项既有HTTP跳过及lint通过；持久微信项目重新构建。后台规格及质量、键盘质量独立只读审查通过；未改框架、依赖锁或业务schema。

## 当前持续本地开发（2026-11-16）

- **入口**：`dev:local` 管理工程外唯一专用配置、已识别 SQLite 和自有子进程；数据和 S3 图片在停止／重启后保留。真实重启前后配置、schema、模板 ID 与图片 SHA 一致。首次开发管理员 `admin / 123456` 已在原生后台登录；已有账号不重设。
- **开发身份**：仅本地开发入口按私有目录标记启用后端身份适配器，正常签发 opaque session；生产拒绝开发目录。不要求真实微信凭据，不伪造前端登录；用户与100积分仅首次创建，重复登录同用户、新会话、无重复赠送。
- **实际阻断修复**：Next 各 bundle 的 runtime 改为绑定 Payload 实例；热更新保留旧 runtime、替换新 hooks 时，原独立 gate 会误拒正常写入。现仅共享无状态检查 dispatcher，各 Payload 的私有 capability 不共享，原 hook 注册、foreign／复制／sealed 请求校验保留。配置或该 dispatcher 代码变更仍需重启，不宣称完整 runtime 热更新。
- **本轮真实 HTTP**：22步通过，包含登录201、幂等会话、真实触发 Next/Payload 热更新后再登录与新建会话、两图 multipart201、S3 原字节 SHA、匿名私图401、草稿 PUT/GET、收纳／积分读取。未配置模型报价503 `GENERATION_NOT_CONFIGURED`，余额100、占用0，无生成任务或付费调用。
- **新专用微信项目**：原生登录201、两张 wxFS fixture 上传、补充输入持久保存，删除仅本轮临时本机照片后重新进入同会话仍可从服务器恢复照片和文字；我的100分、空收纳柜接口200。picker mock已恢复，旧R19未动。键盘高度300的模拟遮挡已修并复验，见上节；不是手机软键盘验收。
- **当前源码回归**：本次后台改版前标准Node1183通过／零失败跳过，应用no-emit、hook三文件lint／格式通过；Native定向4通过、49按选择跳过，覆盖开发身份、Native登录、foreign gate和正式端点，未运行完整Native。后台真实1.8MB官方图片上传、草稿保存回读及检查当时已通过；明确发布／刷新已于上节新版界面补验。
- **边界**：持久入口与专用微信项目保持可用；`image:null` 明确阻止生成，不把历史图片替身结果混入当前收纳柜。真实模型、真实微信及原完整Native SIGSEGV仍待。下节是独立历史临时目标，不代表当前持续服务已停止。

## 本地 MVP 历史临时目标实跑（2026-11-16）

本轮按用户要求收口到主流程，不追加功能或扩大测试平台。当前 Taro 源码经现有构建器输出新专用目录，10 页产物校验通过；没有重装依赖或修改框架。实际 Next 启动暴露 `new URL('../../', import.meta.url)` 被 Webpack 当作目录资源的问题，改为等价 `node:path` 目录解析后，健康接口及后续主链通过。

- **真实依赖**：新 SQLite 目标、独占 Redis、本地缓存固定镜像的 MinIO；普通 API 使用正式配置／组合根。AI worker 用已有 typed port 的图片替身；Wechat 身份用当前时刻新建的本地测试会话，没有读取用户照片或调用付费模型。
- **HTTP**：39 请求完成两张 multipart 图片上传、free/effect 草稿回读、报价、同请求重复受理、暂停 worker 时只预留 1 点、Native jobs 交付、收藏／收纳、私图 SHA 与匿名 401；两轮余额由 8 到 6、占用归零。
- **模拟器**：当前构建实点模板、两张真实 wxFS 测试图、实际 getImageInfo／upload、页内补充、一次生成、收藏与收纳；390px 页面无横向溢出，底栏完整。额外一轮 UI 生成后 SQLite 中三任务均 succeeded、各 1 点，三作品存在，关闭客户端后新目标 quick_check=ok。所有结果图是测试替身，不能推断 AI 效果。
- **修复与回归**：单个生产文件一行路径解析修复；实际 Next 编译失败到 HTTP／模拟器成功构成复现与验证。独立只读审查通过；主仓 Node1159／1159、app no-emit、该文件默认 lint／格式通过。业务 schema、依赖和锁未变。
- **恢复与边界**：所有本轮服务已关闭；Next 自动生成的 next-env 已回原字节，R19 的 49 业务文件、两配置、原 token、chooseMedia mock 及本轮测试照片均已恢复／移除核验。旧六失败 DB 不打开、不重放。真实 OpenAI／Wechat、手机软键盘、在途冷恢复及原完整 Native SIGSEGV 仍待，不标记整体完成。

### 中断恢复实跑：S3 已写入、SQL 尚未登记（2026-11-16）

在另一全新目标通过 15 次真实 HTTP 请求和两个独立 worker 进程验证：两图特效受理并预留 1 点；第一个进程经正式 Native jobs 调用图片替身、写入真实 MinIO 后，在 `output_ready` 落库前被 SIGKILL。此时接口仍为 running、无作品、1 点占用。等待真实处理租约过期后，新进程通过同一 Native queue 认领任务，从原 S3 输出恢复并交付；再次 drain／重复受理后仍只有同一 task、一个 attempt、一个 artifact、一次 reserve 和一次 capture，余额 8→7、占用归零。收藏与成品字节 SHA 均通过，quick_check=ok。

- 仅 typed storage 端口在真实写入返回后触发故障；图片引擎全程只调用一次本地替身，第二个进程若调用模型即测试失败，实际未调用。未增加或修改产品代码、表、依赖或框架。
- 测试实例的 Native claim lease 显式设为 30 秒，以实际等待替代改写 lease 数据；正式默认 20 分钟未修改。Redis／MinIO 保持运行，属于 worker 冷进程恢复，不证明 Redis／存储容器重启、模型已收费但输出尚未存储等其他窗口。
- 两个 worker 分别终止／正常退出，控制器及其 Next、Redis、MinIO 已停止，next-env 原字节恢复，全部 534 源摘要保持。既有六个失败库未打开。该用例通过不抵消原 libsql 原生崩溃，不代表全部恢复场景完成。

## 当前运行入口与验收边界

默认配置只注册正式组合根的31个自定义端点，不再注册旧业务端点／任务。2026-11-14版本的所选真实Next创作核心流程曾在一个全新目标完成两轮独立进程验证（23项业务断言）；此前两个目标结果仅为历史。Native路由测试不等于外层Next服务器全端点通过。客户端主要工作流、带回输入／多图整理及受控weapp编译已有证据，微信Runtime／真机仍待。产品需求与原型进度统一看私有资料库，本文件只记录工程运行与验证。

### 生成核查与人工结清：本地核心运行已验（2026-11-16）

- 正式组合根增加内部 `reconciliation` 服务，宿主命令为 `generation:reconcile --config ABSOLUTE_JSON --command ABSOLUTE_JSON`。仅 Native active admin 可操作，用户端没有释放积分入口；默认 jobs worker 仍为 `trustedClose:null`，核查实例的图片 engine 固定为 null。
- `inspect` 只读；`recover` 仅复用原可信输出恢复，不新发模型请求；`close-undelivered` 需要当前 attempt、operation 与显式确认。查存储在锁和事务外，完整唯一对象先恢复，完整零对象且无既有输出事实才人工结清；不完整、异常或冲突不视作不存在。每次写在原资源顺序／同请求事务内重新验证 Native 身份与完整任务、资金、审计事实。
- 已关闭返回原 operation 及实际返可用／到期数量，不把新 operation 伪称执行成功。未知提交、多阶段已写后失败与确认后清理失败分别保留；不自动重放或改旧任务。规格复审另修正了已知 failed／cancelled 被误报 pending 的问题，补只读、零存储／模型调用及资金不变回归。
- 主仓修后独立执行标准 Node **1159／1159，失败／跳过均为 0**；新增 43 项源码回归。应用 no-emit、新命令在同应用 project references 下的 checkJs、15 文件默认 lint／格式通过。独立 Native 测试类型图仍为 38 项旧诊断，与同参数 fresh 基线全文相同，新目标 0；不表述为全工程类型零错误。
- 原 8 文件备份、完整可逆补丁、534 份当前源与原非写区 519 份、三仓继承 Git 状态和六份旧失败 DB 字节保护已核。没有更改框架、依赖锁、表结构或旧业务 writer；完整源码闭包保护精确覆盖三个新增生产模块，未排除新文件求通过。
- **真实运行补验**：全新正式 ready 目标／Next／SQLite／Redis／MinIO，Native jobs 经 typed 图片替身返回 unknown 后保留 1 点占用。7 次独立正式 CLI 子进程覆盖 inspect、无效 Native JWT 拒绝、无输出 recover 仍 pending、确认未交付关闭、原 operation 重放、新 operation 再关闭及迟到输出后的 recover。14 次 HTTP 核实原任务闭合、余额 8→7（占用）→8、占用归零、同 clientRequestId 不新增任务、零作品。账本只有一次 reserve、一次 release、零 capture；重复关闭始终返回原 operation。
- 在关闭后向同 task／attempt 的真实 S3 结果键写入合法迟到图片，默认 worker 与正式 CLI 均保留 closed，未交付、未扣款。第一版临时迟到图片注入器漏了 verifyBackend，产品按契约拒绝 UNVERIFIED_BACKEND；只修临时注入器并接着验证同一个已关闭任务，原失败记录保留，没有重建任务求通过。图片替身合计一次、付费调用零；外部 fetch 防护未触发。没有修改产品代码、依赖或表；服务已停止，534 源摘要保持、旧六失败库未打开。
- **仍未验收**：原新 Native spec 的 3 项基础试例尚未执行；授权／结算专项竞态、提交结果未知、基础设施重启不由上述串行 CLI 用例证明。前节 worker 冷恢复只覆盖 S3 已写／SQL 尚未登记窗口。原完整 Native SIGSEGV、模板管理真实后台、真实微信／手机软键盘仍开放；没有启用自动超时结清、迁移旧库或调用付费模型。

### 模板管理：原生表单源码切片（2026-11-16）

- 原生custom view／导航、明确命名Server Actions与结构化字段，复用既有管理读、分类／标签、官方上传和发布服务。没有另一套后台、玩法执行器或数据库版本列；草稿并发保护只在现Redis／短事务内比较原内容指纹，发布确认时间来自现服务注入时钟。
- 初轮源码主仓Node1074／1074、定向Native17／17仍未发现两处交互缺陷；独立审查用真实React内存DOM复现参数重挂失焦、用真实codec复现未完成稿回读误判损坏。原writer先加真实失败回归再修复，质量审查随后又复现陈旧页面审阅新配置、游标混用未提交筛选两项问题；修复后同源inspect核载入版指纹，分页绑定实际应用查询。规格复审与质量复审通过。原Issues、失败日志与初轮冻结未覆盖，不把初轮绿色写成无问题。
- 修复后主仓独立执行默认Node1086／1086、定向Native两文件17／17；应用类型退出0、独立测试类型图仍退出1／38项旧诊断全文相同；16文件默认lint、格式及CSS lint退出0。原16写区、外围501源、三仓Git和旧失败DB字节摘要保持。未重跑原完整Native失败集，未调用模型或启动产品服务。
- 两新增回归实际挂载React19＋现有Vitest peer happy-dom，确认连续参数编辑同节点／焦点、非法文本阻止保存，以及未完成稿真实保存回读后同版本补全；另有实际Editor与真实service回归验证陈旧inspect、固定分页查询。仍不是浏览器原生键盘、微信或AT证据。真正坏JSON／未知组原文保留；领域发布校验没有放宽。
- owned Next／Redis／私有MinIO及透明存储观测的部分测试源码已增补，见下节；异常矩阵仍未齐备。**尚未运行**：正式Next页面／Actions／REST同次跨层注册与错误class身份、大于1MiB真实原图至私有存储及表单保存检查发布重载、production build、实际axe／主题／键盘／屏幕阅读器。新E2E文件存在不代表这些门禁通过。
- 本片只接受源码；完整C和产品目标继续开放。后续先闭合上述必要运行证据，不继续追加管理功能或新框架。

本轮焦点收口：仅Fields与既有Node／E2E测试3文件变化；添加示例定位新输出并聚焦原文件控件，删除／移除后定位相邻内容，排序维持同图身份，不在初始、背景更新、readonly或pending抢焦点。5项新真实React内存DOM回归先失败后通过，规格／质量审查与主仓默认Node1091／1091、app类型、3文件lint／格式通过；独立测试类型仍38旧诊断全文相同。未改后端，本片未重跑Native。未变Taro默认检查2296通过／2旧HTTP跳过及src lint通过；客户端189份源码与Git保持。E2E新增add/delete实际聚焦断言但未运行，浏览器／AT仍待。

### 模板管理：部分 E2E 验证代码（仅源码，2026-11-16）

- 仅调整 11 个测试文件：固定正式配置与 CLI、新目标生命周期、透明 S3 流观测、受控运行证据，以及表单正常／部分异常分支。不修改产品服务、框架、依赖锁或既有 MinIO watchdog；不创建另一套运行平台。
- 规格审查修复了损坏分组重建时动态列表定位越界；质量审查修复了 Next 父进程先退出便跳过残留检查。当前按固定分组操作，退出后仍核查进程组和监听；未证明归属的残留只报清理失败，不猜测终止进程。原失败记录保留。
- 修复后主仓独立执行默认 Node **1116／1116，失败／跳过均为 0**，其中新辅助代码 25 项为纯 DI／流测试。应用 no-emit、11 文件默认 lint／格式通过。独立 TS 图仍为 38 项旧诊断；新增 mjs／CJS 的 checkJs 图仍为同依赖基线 436 项诊断，两者各自全文相同、新目标诊断 0；不表述为全工程类型零错误。
- 原 48 处浏览器断言的动作与对象已核迁移，包含实际焦点断言；浏览器未运行。存储对象丢失、部分授权／上传边界、精确公开 DTO、审核时间、多帧及完整回滚／下架等覆盖仍未实现。unknown Error、伪 code、真实提交未知在正式 Next 中缺少注入接口，保持开放，不用网络 ACK 丢失冒充。
- 正式 Next／Redis／私有 MinIO／SDK／浏览器、production build-start、实际观察器传播及 AT **均未执行**。本片不重跑 Native、不启动产品服务、不调用模型；完整 C 与整体产品验收继续开放。源码与六份旧失败数据库文件字节保护通过，存量任务与余额未变。

### 模板管理：官方示例上传增补（2026-11-16）

- 仅增补一个Native-cookie二进制入口`POST /api/v1/admin/media/examples`，以及现存媒体服务、S3命名空间与组合根接线；普通用户上传与取图合同保持。未增加后台平台、素材库、数据库约束或依赖。
- 主仓独立执行标准Node套件1060／1060，定向Native五文件91／91；应用类型检查退出0。独立测试类型图退出1，38项旧诊断全文相同；13文件默认lint退出非0，308项均继承、新增0；格式退出0。规格／质量审查通过，冻结13文件、495外围源、Git继承改动与旧失败DB字节摘要保持。未重跑原完整Native失败集。
- 实际Native登录Cookie、官方POST、生产存储adapter条件写／读回、媒体登记和公开示例读取在原100000字节预算及环回HTTP S3替身中通过；实际Sharp解码，不受用户reference单图预算或零图策略误限制。另一个既有真实缓存MinIO用例通过，不能据此称新官方整链已经过真实私有桶。
- 图片网络和解码在Redis锁／SQLite事务外；T2在同一请求事务复核管理员再登记`owner=null / purpose=example / visibility=official_public`，只返回五字段安全DTO。未知提交只读核对一次，不自动再次PUT／登记／删除；未引用对象保留，无跨进程自动找回承诺。
- 身份入口未知角色按403拒绝；事务中物理管理员行出现非法枚举按503完整性错误拒绝，零媒体插入。两者都不扩大权限，也不把坏数据库事实当正常权限拒绝。
- 原生表单仍待接线。大于1MiB原图经真实Next、Cookie、私有MinIO条件写／私有读回、表单关联、检查发布与重载是后续完整验收门禁，目前未执行。生产构建、真实微信／手机及付费模型亦未因此通过。

### 最新完整Native复验（2026-11-15，未通过）

- 清理卡片专属候选后的496份源码（Payload292／Taro189／AI15），原28文件配置无名称／路径筛选、单worker运行。**27文件完成，725项通过／737项计划；12项未完成，1个未处理错误，退出1，117.99秒。** 不能把已完成项数或另行通过的76项模板专项合计成全量通过。
- `owner-credits.int.spec.ts`所在worker发生SIGSEGV。系统报告记录PID90858，Node24.22.1与libsql0.4.7 arm64的UUID均与本地二进制匹配，崩溃栈进入N-API finalizer。当前仅证明同类原生稳定性故障再现，不证明是哪一个具体对象／业务查询触发，未用重跑或扩大重试掩盖，也未提升被拒的候选依赖。
- 使用既有依赖、禁环境文件发现的测试配置、新TMP下的自有SQLite和随机环回Redis／S3故障替身；真实MinIO测试使用本机固定缓存镜像，`--pull never`、CPU1／内存及swap512MiB／pids128／无日志／tmpfs限制由fixture实际inspect核验。真实MinIO条件竞争、不可变读回与匿名私有性用例通过；不是生产存储耐久性或整体通过。
- Vitest外层的Node堆上限3072MiB；没有新装依赖、启动Next／产品队列、开放公网、调用模型或上传微信包。测试开始前约12GiB可用磁盘；未记录连续RSS峰值，不把堆上限当完整进程树内存限制。
- 失败的临时SQLite及其WAL／SHM保留，不打开或迁移；运行结束后没有文件句柄占用本轮目录，所观察进程组已无成员，本轮随机前缀MinIO容器已不存在。旧失败库的三个摘要、496份原源码、三仓HEAD／暂存与继承dirty保持；随后仅本README与本验证说明更新，不声称文档SHA未变。
- 原始日志、实际退出码、系统崩溃摘要、失败库摘要及保护检查保存在工程外证据目录；本文件只维护结论和重现入口，不提交日志、库、凭据或崩溃报告。当前资料不能证明真实Next、微信宿主／手机输入或付费模型质量通过。

### 历史命令别名退役（2026-11-14）

应用package scripts已移除`setup:local`、`test:creation-http`、`test:admin-http`、`test:http`、`test:mvp-http`、`test:unified-spike`及`dev:creation-fixture`七个历史别名，未以新别名恢复。下方历史记录中的这些名称已不再是可执行package入口；旧脚本／测试源码保留历史，不作为当前操作建议，也不代表旧协议仍在正式运行。

正式初始化、管理CLI、jobs及开发／构建入口保持原有影响与显式环境／费用边界，使用前见[工程README命令影响](../README.md#命令影响)。本次仅退役元数据入口，不重跑旧HTTP或实验服务，不改写下方既有日期、数量、失败记录及Native限制。

### 当前源码完整Native复验（2026-11-14）

- T21在当前284 Payload／130 Taro／15 SDK源保护清单下，单次运行原28文件配置，**737项全部通过、0跳过／0失败**，实际Native退出0、131.76秒、未触发600秒期限。未加`testNamePattern`或路径筛选；逐完整用例名与T17的736通过＋1延期集合一一核对，不累加历史次数。既有测试／helper、生产代码和依赖均未改变。
- 原唯一延期的真实MinIO用例实际执行：两个独立AWS SDK客户端竞争同一条件写，只有一个成功；不同内容不覆盖、同内容重放保持原字节、实际读回及匿名403均通过。使用本机固定缓存image ID、`--pull never`、自有临时bucket／tmpfs；不是S3内存HTTP替身，也不是生产版本推荐、持久卷重启／灾备或真实用户存储验收。
- 原fixture创建后真实inspect确认CPU1、memory及swap512MiB、pids128、无容器日志、tmpfs与唯一127.0.0.1随机端口，受32MiB测试数据预算约束。外层观察器额外记录创建前不存在的精确随机name、不可变首ID及pin，不记录环境／凭证；真实调用仍沿原argv／env／stdio，不给shared helper塞兼容或改限制追绿。本次fixture自己关闭容器，父进程未代删；结束后精确name及ID均不存在。
- 本轮Native子进程使用已审新HOME／TMP与原策略：只允许环回IP、拒env与工作区.data读取、源／依赖只读、仅两个明确Vite缓存额外可写；新增一条canonical Docker Unix socket outbound并保护观察器／policy不可写。真实kernel只读版本／image探测与环境／越界写拒绝均通过。该例外允许访问Docker API，不代表只授权一个API动作；宿主seatbelt也**不限制Docker daemon／VM中容器的出站网络**，不夸大为完整容器网络隔离。
- Node24.22.1／单worker／heap4096／禁core dump，串行运行；外层采样门限为host组11GiB＋容器512MiB＋controller预留512MiB，总预算12GiB，磁盘保留8GiB。观察到的组RSS最大1496924160字节，仅为采样值，不是精确峰值或内核硬RSS上限。302个已观察宿主PID结束，PGID95069为空；容器不是宿主PGID成员，已另核归属及清理，不能拿killpg替代容器关闭证据。
- 根及独立审查核原始逐case日志SHA、source完整成员／Git／ignored10、创建意图／首ID绑定和当前进程／容器终态；运行前后原源码保持。验后仅更新工程README／本说明两文档，更新后SHA另登记，不把文档变化当业务代码重验。
- 完整配置此次通过，未观察SIGSEGV／未处理异常；不声称历史libsql间歇崩溃根因已修，也不证明跨重启生产耐久性、实际Next外层、当前客户端至API、微信Runtime／真机或付费模型质量。后端所选Next仍沿下方T18独立证据；客户端R14受控编译仍非宿主验收。下方T17筛选结果仅留历史，真实MinIO延期在T21这一明确范围关闭。

### T17筛选Native复验（2026-11-14）

- 对T15-C后冻结的284 Payload／127 Taro／15 SDK清单运行现有28文件配置，未改测试／helper／生产代码／依赖。实际退出0、未触发600秒期限；逐例核验737项＝736通过／1明确延期，28文件均有通过项。
- 唯一延期精确为`s3.int.spec.ts`的`real cached local MinIO (distinct from HTTP fault fixture) > two actual clients race with one conditional winner; immutable replay preserves bytes and anonymous bucket stays private`。本轮只读显式local Docker version预检4秒超时，未启动daemon／Desktop或拉镜像；CLI使用`--testNamePattern '^(?!.*real cached local MinIO)'`，不是未过滤的完整Native总门禁通过。S3 HTTP故障fixture仍不替代真实MinIO。
- 沿下方默认配置与环境约束，但实际调用由受审策略执行：新专用HOME／TMP、只限环回网络、拒读env文件及工作区.data，写入仅本轮目录及2个明确Vite缓存。白名单无危险DROP／MIGRATING或旧服务配置；Node24.22.1、单worker、heap4096、禁core dump，无源码／依赖复制和安装。缓存不意味着冷编译；未运行默认产品服务3001／6379、旧HTTP或付费模型。
- 根及独立审查均核原始日志SHA、逐例名称／数量、Native实际exit／deadline，而非仅看包装器退出。278个已观察PID已结束、PGID34709无残留，未结束预存或其他任务Redis。运行前后源码及Git／ignored10保持，验后仅更新工程README／本验证说明，不把2个文档SHA变化说成业务代码变化。
- 本次未观察SIGSEGV或未处理异常，仍不是历史libsql崩溃根因已修。该次Native未验证所选实际Next HTTP，后续当前源码HTTP结果见下节；完整MinIO、模型／微信真实能力、Runtime／真机仍分别保留。Node744是T15-C先前独立结果，本轮未重跑，不混加成当前集成数量。

### 当前源码所选Next HTTP复验（2026-11-14）

- 用当前T15-C后源码、3471项完整runtime清单及284 Payload／127 Taro／15 SDK原始保护清单，复用已有锁定依赖；精确11文件source-only同步（2新增、无删除），相同rsync排除与files-from先dry-run后复制。没有重新安装／复制依赖、整仓副本、框架修改、旧数据迁移或默认3001／6379服务。
- 一个从未使用的target先完成正式`core-init`＋`attest`退出0，所有自有资源关闭后封ready；另起business epoch，经独立Gate B运行两轮不同Next进程。不是`verify-existing`旧通过目标，也不是只有health的入口；不把此前双目标证据重复累计。
- 当前实际23项断言全部通过、47条JSON trace、16个业务命令退出0。覆盖正式trial、模板及free目录、会话创建回放、本人multipart多图与顺序／effect补充文字／free必填描述、报价零写／零引擎、并发同键单任务、原生生成／命名jobs、成品历史／收纳／私有媒体／收藏／积分、冷进程恢复、过期报价但会话有效、同键稳定回放、改输入冲突、换一张来源快照、异主404及幂等注销。完整断言集不等于30端点及全部故障矩阵。
- 两轮compiled route确认来自该镜像的typed host；当前Sharp适配器与媒体schema实际进入server runtime chunks，模型／微信调用记入所属进程journal。测试使用真实本地SQLite／Redis和实际SDK至内存S3 HTTP；图片／命名／微信为明确的零费合成端口，不证明真实AI效果、微信上游或MinIO持久性。
- 根及独立审查核验原report／18个init与business attempt、ready及dataset归属、153项历史proof SHA、源完整成员／overlay／原仓Git、零active lease与关闭端口。business报告42个产品PID已结束；合并初始化、controller／Redis及资源采样共62个已观察PID当前均结束。测试没有新运行源码或依赖改动，验后仅更新本说明与README两文档。
- 资源限制为产品Node各3072MiB、Redis32MiB且不持久化；本轮串行，磁盘保留8GiB／总RSS预算12GiB。资源matcher首次误排带`bin/node`路径，根已修正临时观察脚本；24次采样中20次有活动进程，观察最大RSS约2.63GiB、最小剩余磁盘约18.23GiB，仅证明修正后部分区间采样，不称全程连续监控或精确峰值。没有因观察超时重跑通过目标。
- 本轮实际初始化及business CLI均退出0；不是冷依赖安装／冷构建／冷基础设施、真实模型／微信、全部端点或真机验收。Native736／唯一MinIO延期与历史崩溃根因沿上节边界，客户端受控weapp编译仍不等于Runtime／真机。

### 历史Native入口与结果（2026-11-13）

> 以下保留当时的运行入口与排错记录。默认全量配置仍保留所有测试，但本轮实际筛选范围以上节为准；不将旧结果当成当前源码证据。

在Payload仓库根使用符合engines的Node与已锁定依赖。以下是**保留全部测试的默认入口**，不是无差别执行指令；先确认临时目录归属及本机依赖：

```sh
env -u PAYLOAD_DROP_DATABASE -u PAYLOAD_MIGRATING \
  NODE_ENV=test PAYLOAD_DATABASE=sqlite \
  pnpm exec vitest run \
    --config apps/heymoro/tests/creation/vitest.config.ts \
    --reporter verbose --maxWorkers 1 --no-cache
```

- 配置禁止发现环境文件；fixture创建独立SQLite／上传目录与随机环回Redis、S3 HTTP服务，不连接默认开发库。真实MinIO用例会使用固定本地缓存镜像创建自有资源受限Docker临时容器；运行前须确认Docker与该缓存可用，不自动拉取或启动／重启Docker Desktop。
- 正式运行时拒绝危险清库／迁移开关。不要给整套Native测试统一设置`PAYLOAD_DROP_DATABASE=true`：它会在正式runtime套件collection前被拒绝；不为追绿关闭这层保护。
- 本轮先运行当前owner-credits，实际68／68通过；旧记录22是历史数量。完整配置包含28文件。首次整套运行614通过／1失败，另9文件因上述启动环境错误未进入测试，不能算完整验收。
- 纠正运行环境后，28文件实际736项通过、1项明确延期；该唯一延期是「real cached local MinIO」用例，原因是本机Docker只读预检未响应。实际命令用了显式名称过滤，不是上方全套默认命令；过滤范围、失败与完整日志均保留。本轮S3 HTTP故障fixture通过不替代真实MinIO。
- 已执行路径未复现SIGSEGV，**不是历史Native崩溃已修复**。未改生产／测试运行源码、共享helper、事务、close或依赖版本；未做猜测性phase插桩。真实MinIO和历史间歇崩溃的根因仍单独保留。
- 根在独立临时HOME／TMPDIR及环回网络、限定写目录／拒环境文件与工作区.data的内核策略下运行；只额外允许两个明确Vite可重建缓存。复验源清单、Git基线及275个已观察PID终止、进程组无残留；首次错误运行的9个自有Redis孤儿按本次PGID收回，未结束未知服务。未复制源码／依赖、升级库、启动默认产品服务或调用付费模型。

下方各日期／切片为当时历史，不替代上述当前入口与仍待关卡。

## 2026-11-12 · 实施前基线

- 独立 Node 24.22.1＋pnpm 11.28.6；不修改系统运行时，不读取环境文件或存量数据库。
- `pnpm product:test`：48 通过，0 失败；只证明旧单元／边界基线，不代表新版 API。
- 应用目录尚未被 Git 跟踪；修改前逐文件哈希与既有 tracked diff 已单独记录，不整体暂存 `apps/` 或其他工作。
- 未运行 HTTP、队列、S3／Redis、真实模型、构建或迁移；后续结果在本节更新，不累积历史通过次数。

## 2026-11-12 · T01 输入边界

- 新增纯领域输入模块：effect／free 与 draft／quote／submit 校验、不可变有序副本、原始文本保留、输入及任务内容摘要。
- 实际先观察缺模块的 19 项失败，再实现；主会话复跑定向 19／19、完整 `pnpm product:test` 67／67，无跳过。规格和代码质量审查通过。
- 单文件严格类型及格式检查通过；未把此结果视为整应用类型／构建、数据库、HTTP、模型或真机验收。旧端点尚未切换。

## 2026-11-12 · T03-A 会话创建用例

- 受协调工作单元、专用仓储、时钟和能力策略显式注入；同键回放、软删键保留、多行异常、模板发布指针及版本兼容规则已实现。会话与空草稿的创建／修改／软删审计字段由服务提供。
- 实际先观察缺模块的 21 项失败，再实现；主会话复跑定向 21／21、完整 `pnpm product:test` 88／88，无跳过。三个纯源码模块严格 TypeScript、三个新增会话文件格式检查通过，两阶段审查通过。
- 此处仓储／事务为显式测试替身；未证明真实数据库原子性、Redis、HTTP 或端点接线。未启动服务、迁移旧库、调用真实模型或变更页面。T03 整体仍未完成。

## 2026-11-12 · T04-A 真实 SQLite 适配

- 目标模板、版本、会话、草稿四 Collection 已建立，专用仓储接到会话创建用例；默认应用配置与旧数据库未切换。全部业务 ID 为普通数字字段，标准审计／软删除态有门禁；原生和 overrideAccess 写入缺少私有请求能力时拒绝。
- 当前 libSQL 忽略 Drizzle behavior，框架事务路径可能消费后期错误。产品层用同 client／schema 的受限适配，实际调用 `client.transaction('deferred')` 并直接等待提交，不修改框架。请求注册、in-flight drain、提交前 seal、未知结果不自动重试及 owned Transaction 清理均有回归。
- `pnpm exec vitest run --config apps/heymoro/tests/creation/vitest.config.ts`：25／25，主会话连续复跑 3 轮。真实空库／WAL，包括真实 BUSY 快照冲突重读、触发器拒绝第二写的整笔回滚、提交前迟到额外写与确认等待窗口。部分确认丢失通过明确故障注入，协调器为假端口，未验证 Redis。
- `pnpm product:test`：88／88，无跳过；应用 `tsc --noEmit --incremental false`、7 个新增源码／测试文件格式检查通过，规格与质量复审通过。
- 独立测试类型图临时配置仍报 38 个框架／共享 helper 诊断，新应用文件 0 诊断，不计通过；不关闭应用 strict 或修改共享 helper。应用 tsconfig 仅排除 `tests/creation`，不把 Vitest 全仓类型图编进 Next 运行时。
- 最终 Vitest 配置 `envDir:false`，无根 setup、无手工 Payload 初始化；早期配置未显式禁环境发现，不作为该门禁通过的证据。临时库由共享 fixture 管理，测试自行关闭创建的客户端并清理自有目录。
- 两个直接依赖与现有安装版本一致：drizzle-orm 0.45.2、@libsql/client 0.14.0；离线禁脚本操作。主会话语义比对确认其它 lock importer／版本快照及既有 tracked diff 未变。
- 本次未运行默认服务、真实模型、S3、Redis、迁移、页面或真机验证；上述证据不是整个核心闭环完成。

## 2026-11-12 · T04-B 真实 Redis 租约与 SQLite 联测

- 新增显式 URL、有限连接／命令时限、禁止离线排队／自动重放的 Redis client；协调器采用持有者比较的原子获取／续租／释放、保守单调截止和最大持有期。单／多资源键一致，锁链按会话→任务→钱包及业务数字 ID 排序。
- `pnpm exec vitest run --config apps/heymoro/tests/creation/vitest.config.ts`：49／49，主会话最终连续复跑3轮。包含旧 SQLite25 项，以及真 Redis 互斥、续租、到期、错持有者、连接断开和真实 SQL 同键一会话／一草稿、锁忙或不可用零 DB work、失锁回滚。
- 根主会话重复执行曾复现资源繁忙偶报503；新增真 Redis＋扣留末次SET响应的确定性回归后修复为获取等待预算409，命令错误／超时与TTL／maxHold失效503，旧断言未放宽。SET／EVAL响应丢失和延迟明确属于故障注入，不冒称真实网络事故。
- 88／88单元、应用 `tsc --noEmit --incremental false`、6个TS文件格式通过，规格／质量复审通过。独立测试图仍有38项框架／helper诊断，新增文件0，未计全图类型检查通过。
- Redis只在自有随机环回端口，禁持久化、32MB／noeviction；fixture等待自有child退出、关闭登记client并清理自有目录，不连接6379、旧数据库或其它Redis。临时测试配置继续禁环境文件发现，不调用根setup。
- package／lock仅新增当前已安装的ioredis5.11.1直接依赖；其它依赖快照与原有tracked diff未变。现有SQLite源码未变，原spec仅扩充明确隔离include列表；package既有script排序差异未越界格式化。
- 尚未启用缓存、切正式端点、接媒体／计费／模型或真机；租约不是fencing／HA或恰好一次证明，完整本地闭环仍在实施。

## 2026-11-12 · T03-B1 公开模板目录

- 新增公开配置领域校验、目录应用服务和独立 Payload 只读仓储；分类／标签目标 Collection 仍私有并复用写门禁。公开源字段显式 select，不读取内部 generationConfig／shareConfig；不为读取申请 Redis 写租约。
- 目录只含已发布兼容特效，支持分类与名称／标签／别名搜索交集、签名 sortOrder/id 键集分页及有界扫描续页。详情可读取仍有效的旧版本，free 按独立 code 查重入口读取；重复键包含软删记录，完整性异常503。
- 新增36项真实 Payload＋隔离 SQLite 集成；主会话独立复跑全套85／85、单元88／88、应用strict、7文件格式及3个新源码lint，两阶段审查通过。目录测试包含102项taxonomy跨批读取，不靠固定上限静默截断。
- 独立测试类型图另发现本轮2项spec类型错误，已修复并独立复验：38项既有框架／helper诊断、本轮0项；测试类型全图仍不算通过。未修改框架或关闭应用strict。
- 旧端点与默认配置尚未切换；示例只返回媒体ID，不证明媒体已公开可读。T0完整配置联动、发布管理、草稿媒体归属、模型与页面仍待后续切片，不将目录服务通过算作产品完成。

## 2026-11-12 · T03-B2 本人媒体与整份草稿

- 同一Media目标工厂深拷贝既有定义，继续复用owner/originalName/storageName/mimeType/filesize/timestamps，补真实存储位置与审计等缺失字段。真实Payload合并后的filename普通索引及media/draft_inputs零业务FK／UNIQUE已以PRAGMA验证；默认Media定义未修改或重复注册。
- 草稿按固定版本、本人active私有reference图片和有效格式／大小保存整份输入；多图顺序与原始文字保留。位置槽位复用、清空软删与恢复、最近活动同req同deferred事务；不创建模型任务或扣积分。
- GET采用独立只读一致快照，不申请Redis或写capability；模板下架、媒体后来失效或上限收紧不静默清空旧输入。框架abort后永久拒绝继续读，结束后封口并释放自有事务。
- 主会话独立复跑118／118真实隔离集成（新增33）、88／88单元、应用strict、12文件格式与5新源码lint；规格及质量审查通过。SQL触发器／第二SQLite连接／真实Redis分别验证部分写失败、快照一致和失锁回滚。协调正常路径部分采用明确替身，不将全部草稿用例称为真Redis并发验证。
- 独立测试类型probe补入旧应用生成类型上下文，修正4处动态fixture slug观测边界后仍38条既有框架／helper诊断，产品0；不计全图通过，不改框架或生成类型。
- Users目标schema缺status或isDeleted checkbox时，草稿工厂在DB／Redis前立即报配置错误；旧Users尚无完整目标字段，组合根前必须补齐，未通过缺字段兼容掩盖该缺口。未切默认端点或迁移旧库；S3只用元数据fixture，字节上传与完整闭环未验收。

## 2026-11-12 · T05-A 积分发放与到期底座

- 新增真实credit-accounts/grants/ledger，复用审计／门禁／普通索引。宿主内部发放与到期按钱包协调，全局grantKey及eventKey含软删查重；同内容重放不再发点，来源与期限不可原地改，账本禁止更新、软删和物理删除。
- 批次守恒及求和溢出检查、到期仅available转expired而保留reserved；账户是可重建投影。余额GET采用只读快照，不申请Redis或写能力、不创建钱包／到期流水；来源只计当前可用，不回内部业务键。
- 主会话独立复跑171／171隔离集成（新增53）、88／88单元、应用strict、7文件格式、3新源码type-aware lint，两阶段复核通过。测试类型图仍38条既有外部诊断、产品0，不计全图通过。
- 真实SQL触发器、Redis同钱包并发／失锁、跨钱包相同grantKey遇SQLite busy后完整回滚重查均验证。到期保留reserved场景显式seed历史元数据，尚非预留／结算验收；普通协调路径部分仍为替身。
- 已以RED修复锁等待／重试前的旧时钟，以及历史批次N+1：131批余额GET的grant查询由133降为4；补用户普通索引支持归属／孤儿查询。未变更框架、依赖、默认配置或旧库。
- 当前只支持内部trial/compensation发放，未开放用户发点API或接入支付。报价、reservation/allocation、T1与job原子提交、worker capture/release均待后续切片；默认旧端点仍不是该实现。

## 2026-11-12 · T05-B 报价与原子受理

- 报价采用官方jose6.2.12、固定HS256／本地可信keys／issuer／audience／有限TTL；只读snapshot，不拿Redis或写资金。首次受理在外层真实多资源租约内复用既有UOW，同req写task、inputs、reservation／allocation、每批reserve流水、钱包／轮次与真实Payload job。
- 主会话独立复跑197／197集成（新增26）、88／88单元、应用strict、16文件格式和9新源码type-aware lint，两阶段复核通过。测试类型图仍38条既有外部诊断，逐条与上一切片相同、产品0，不计全图通过。
- 验证零价／空分摊、多来源早到期优先、同会话双击、跨会话钱包不超支、失租／allocation与job SQL触发故障整体回滚、真实WAL变更后重开callback及时间重查。报价／旧请求回放与当前配置解耦，回放不重复预留。
- source／replay金融状态与owner缺口已RED→GREEN：读取关联钱包／批次与reserve／capture／release事件，不只看succeeded。正额source以显式完整post-T2 fixture造证据，不能算真实交付结算。
- 换一张冻结来源输入与执行计划，新任务使用当前宿主目的地；source与旧已受理请求不变。key规则以新task／attempt ID及内容摘要派生，结果位置在可信输出前不登记为成功。
- app package／lock语义比对仅加已安装jose6.2.12，无其它依赖漂移。未改UOW／Redis／框架／默认配置或旧库；共用媒体校验抽取后旧草稿回归保留。sentinel handler未执行，未调模型或S3；默认HTTP与客户端尚未切换。

## 2026-11-12 · T06-A S3字节与单一媒体链

- 新增有界流／sharp完整解码、实际MIME／SHA-256／大小与宽高校验。直接AWS SDK显式后端／凭据／bucket／有限预算、maxAttempts=1；先自有随机probe确认条件写能力，再允许If-None-Match媒体写。成功／冲突／ACK不明均回读实际字节，不信ETag或自报摘要，不覆盖或删除冲突对象。
- 同一Media目标工厂，网络在锁／事务外，随后位置协调与短事务登记；同位置包含软删查重。不透明进程内证据不可伪造；T2内部登记复用外层req、不加媒体锁或active门禁。前台上传／读图仍检查active，读取字节后再鉴权；内容／归属／位置创建后不可变。
- 主会话独立复跑215／215集成、88／88单元、应用strict、17个TS格式及5个新源码type-aware lint；两阶段审查通过。测试类型图仍38条既有外部诊断，与T05-B逐条相同、产品0，不计全图通过。
- 真SDK HTTP故障fixture与真实隔离MinIO分别验证。MinIO仅使用已缓存固定digest、本机随机环回端口／自有tmpfs／随机凭据，CPU1／内存及swap512MiB／pids128／无容器日志／测试数据32MiB预算，结束无自有容器残留；不连接既有桶或把缓存版本推荐作生产。覆盖条件竞争、同异内容、完整回读及匿名403；SQLite触发器／ACK故障另测登记回滚与只读查证。
- 规格复核发现遗漏必填S3预算可落SDK默认，已实际RED→GREEN，四字段omit／undefined八种情况在任何HTTP前拒绝。应用package／lock仅加现有AWS3.1158.0及Node transport4.13.0，其余依赖语义和原有tracked diff不变。
- 未改默认配置、旧Media／媒体服务或用户入口；未运行真实模型、worker结算或新版客户端。固定task／attempt前缀扫描只返回查证候选，不表示已交付或可扣点。完整核心闭环继续实施。

## 2026-11-12 · T06-B worker与交付结算

- 实际Payload jobs.run接入持久attempt：prepared回收、当前attempt发送门控、明确提交后才调用；engine带AbortSignal，网络均在本业务锁／事务外。发送不明保留unknown／reserved，不按租约到期重收费；S3最终对象可验证恢复，不重新生成。
- 同req T2原子登记Media／Artifact、逐批capture及预留／分摊／钱包／任务／attempt／会话与首次命名job；T3明确失败释放，T3C可信内部结清同事务追加原AuditLogs。零价空分摊、跨到期释放和停用owner仍闭合；closed晚图只留私有执行证据。
- 主会话独立复跑288／288集成、88／88单元、应用strict、19个TS格式与7新源type-aware lint；规格与质量复核通过。测试图仍38条原有外部诊断、与T06-A逐行相同，产品0，未计整图类型通过。
- 真Redis／SQLite／S3 SDK环回fixture包含10处T2 SQL触发回滚、审计失败、真实COMMIT后丢ACK、T2／T3C竞争、旧holder、坏资金图与重复逻辑键。源图真实HTTP404在发送前NOT_SENT释放一次；迟到旧404不释放新attempt。模型仅零费用显式fixture，未请求OpenAI。
- 实际RED修复131批N+1、非idle命名证据被重写、图片限制未构造校验／快照、合法grantKey误判与全局事件污染。观测实际Payload SQL和绑定参数的EXPLAIN：账本由全表SCAN变为现有reservation索引SEARCH一次及eventKey范围SEARCH三次，不增加索引或约束。
- 未加依赖、改框架／默认配置／旧库或Taro。命名发送、官方模型包、目标运行档、正式HTTP与新版客户端仍待实施；不是整产品可用或真机通过。

## 2026-11-12 · T06-C1 独立图片SDK与宿主适配

- 同级私有`@heymoro/ai-engine`使用官方openai7.55.0，编译dist JS／类型，只有应用file依赖。宿主按已受理快照合成Prompt并核注册的provider/model，原文字与图片顺序保留；包不接存储、SQL、Redis或业务ID。
- 显式密钥／固定API源、SDK零重试、禁止重定向、成功与错误body在SDK解析前限流，环境头被隔离。无图JSON、有图有序multipart；输出唯一有界canonical base64，unknown不重发。worker仅有限预算块调整至engine≤300s／attempt lease≤600s，Redis／S3预算与财务语义未变。
- 主会话Node24.22.1独立验证：包build／typecheck、51／51 SDK测试，宿主296／296集成、88／88单元、strict、15文件格式与6源码type-aware lint通过。测试类型仍38条原外部诊断、产品0，非全图通过。
- 实际RED修复匹配坏注册项导致模型替换，以及4MB／16MB合法输出regex栈溢出；新大图完整字节、各一请求。8个宿主installed dist SHA与fresh私包完全一致。全部旧依赖语义保留，只增app本地依赖及SDK／私包必要条目；未改框架根package／其它importer。
- 所有SDK测试使用自有环回服务／假key；真实worker只验证合成图片响应与S3／资金事实。不请求OpenAI公网，不证明真实模型质量或费用；一次命名、默认端点及客户端仍待后续。

## 2026-11-12 · T06-C2 一次命名与用户改名

- 自动命名应用用例、用户改名用例、纯名称校验和Payload持久化适配分开；复用现有会话锁／短事务与命名job，不新增表或计费。输入固定取会话最早Artifact（含软删）的首成功任务快照与已验证成品字节，不读取当前封面、模板或草稿；首图失效不顺延挑后图。
- pending→sending明确提交后才在锁外调用一次。发送提交ACK不明、sending到期、断流／超时均不重发；晚结果不复活unknown。真实用户改名始终优先，sending中保留发送时间与状态证据；缺命名配置保留模板名并明确failed。已受理自动任务不因owner后来停用而中断，用户改名仍校验有效身份／归属。
- 私包新增独立Responses适配：宿主显式注册文本模型、单图与闭合JSON名称，固定API源、store:false／零重试／实际响应流上限，限制工具与多消息结果。共享拒绝证据分类，不改变原图片协议；已用RED验证reasoning＋单条最终消息及重复JSON键边界。
- 主会话Node24.22.1独立验证：87／87 SDK（图片51＋命名36）、338／338真实隔离集成（保留296＋命名42）、88／88单元，私包build／typecheck、应用strict、21文件格式与14源码type-aware lint通过；规格、质量审查分别通过。测试类型图仍是完全相同的38条框架／共享helper诊断，产品0，整图不计通过。
- fresh私包与实际宿主installed dist 12／12文件SHA一致；依赖／lock未变，原tracked diff与Taro基线均未变。真实Payload jobs、SQLite和Redis验证重复／并行job、真实提交确认丢失、前后崩溃、用户改名竞态、首图与后续轮次、S3故障和锁外调用；SDK只请求自有环回fixture／假key，无付费模型效果证据。
- 本片没有HTTP改名端点、默认运行档切换、模板发布管理或页面改动；完整本地闭环继续实施，不把SDK与内部handler通过写成真机或产品已交付。

## 2026-11-12 · T03-C1 发布配置驱动会话初始化

- T0首次创建复用目录的严格V1公开解析与宿主约束交集，名称统一复用100 UTF-16单元／控制字符校验及首尾修整；只取所选发布版本display name，不取可变模板名称。hostCaps在初始化时复制校验，调用方后来修改不改变限制。
- 仓储只投影T0所需公开配置／身份字段，不读取私有生成／分享配置；有效空会话不依赖模型配置，示例不成为草稿输入。Users目标schema缺status／isDeleted checkbox时在DB／协调前报配置错误，active只接受严格isDeleted=false；默认Users未改。
- 有效账号与含软删幂等查重仍先于新建配置检查。同键回放即使版本后来损坏、撤回、下架或能力不再兼容，也保留原会话名称、固定版本与唯一草稿；没有新增模型／资金／队列动作。
- 实际RED：原21会话单元通过、新增4失败；新集成22项中19失败，随后最小实现转绿。主会话独立通过360／360隔离集成（保留338＋新22，13套）、92／92单元（保留88＋新4）、87／87 SDK、应用strict与8文件格式；规格和质量两阶段审查通过。新22项为真实Payload／SQLite，协调端口明确采用替身，真Redis仍由原套件验证。
- 测试类型图仍38条与C2逐行同序的框架／共享helper诊断、产品0，整图不计通过。3个改动旧源文件完整仓库lint仍有122 error／11 warning；主会话按文件／规则／消息／严重级别比较全部基线150→133，无新增，不宣称全lint通过，也未为旧排序做整文件重排。
- 精确改动仅3个源文件与5个测试／配置，冻结8文件SHA与原应用／tracked diff、依赖及Taro／私包保护复核一致。未切默认API／运行档、部署或修改页面；发布不可变／回滚／下架管理、正式接口和客户端继续实施。

## 2026-11-12 · T03-C2 受控模板发布与历史保护

- 新增纯不变量、最小typed ports、六个发布用例与Payload适配，目录保持只读；复用既有admins身份、审计、SQLite／Redis和S3，不新增业务表／依赖或通用CRUD。操作者状态／角色在读和写阶段真实查询，fixture身份记录不代表实际管理员登录验收。
- template.code／kind和version归属／发布序号固定；draft才可编辑配置。首次发布记录严格UTC publishedAt，之后四份JSON、售价、能力／schema和发布时间不可改、撤回后也不可隐藏或重发。回滚只切默认版本／检索投影，下架／撤回不改已有任务、成品、草稿或账务。
- 发布检查真实官方示例身份、完整对象字节、输入约束及首次词条快照。只读快照结束后才请求S3，再取模板锁，在短事务复查全部事实并同req写版本、指针与append-only审计。网络期间模板／媒体／词条／管理员变化、失锁和SQL中途失败均阻止或回滚；数据库／S3错误不被粗捕获成业务冲突。
- review绑定配置与当前发布状态、有序示例媒体摘要。inspect后下架须重新确认，提交不明先回读、不自动重发；当前状态摘要不承诺ABA历史检测或fencing。确认仅记为operator_assertion，不当作视觉／配对或真实模型效果证明。当前V1分享配置只预留空对象，未实现渠道分享。
- 独立审查真实发现并修复三项P2：review跨await复用调用方对象、枚举／摘要强制转换、扩展年份未来日期的字符串排序。已以真实S3屏障mutation、getter零执行／零IO和扩展ISO年份验证RED→GREEN；命令现严格复制冻结，保留调用方原对象可变性。初轮factory缺失smoke不宣称全部生命周期用例均先红。
- 主会话Node24.22.1最终独立通过407／407隔离集成（保留360＋新增47，14套）、142／142产品单元（保留92＋新增50）、87／87 SDK、应用strict、新4源完整type-aware lint及20文件格式。测试类型图仍38条与C1逐行同序的外部诊断、产品0，整图不计通过；旧3源样式138→135无新增，当前完整旧源仍112 error／23 warning，未计lint通过。
- 五effect＋free均通过实际服务创建／发布／更新／回滚／下架／撤回；官方示例走真实S3适配与Media登记。另有真实worker交付的Artifact／财务图不被后续发布操作改变、真实Redis并发／失锁及事务回滚验证。SDK与模型结果仅显式fixture，正式客户端五玩法、人工运营审核和真实模型质量仍待验。
- 精确20文件SHA、原tracked diff与依赖、Taro及私包保护均由主会话复核；旧published种子补时间，刻意坏数据用仅测试白名单参数化SQL，原非法业务写仍须失败。未读存量库、切默认API／运行档、改UI、部署或推送公开代码；会话／作品查询、收藏与正式客户端继续实施。

## 2026-11-12 · T07-A 本人成品收纳与幂等收藏

- 新增独立收纳读用例、收藏写用例、严格签名游标及最小typed scan／batch端口，Payload适配持有实际快照／短事务。新增已评审saved_artifacts关系表与两组普通索引、标准审计及写门禁，无业务FK／UNIQUE／行级修订号；收藏不复制图片。
- Artifact投影核对本人、原任务／会话、完整attempt序列、原执行目的地、全局定位与媒体指纹；历史不依赖当前模板或完整钱包对账。父记录隐藏不连带删成品；正常Artifact墓碑跳过前仍校验身份、删除态和全局逻辑键，坏数据不伪装空页。GET仅同一SQLite快照串行批读，不拿Redis／写能力或请求S3／模型。
- 全部和收藏分别按createdAt／savedAt加id倒序，URL saved省略与false同义，签名cursor绑定用户、筛选、端点、排序及pageSize；有界扫描只推进实际消费位置，可空页续扫，不跳过预读未返回项。DTO只有白名单元信息，不生成尚未实现的取图链接。
- 收藏使用本人＋Artifact资源协调；重复PUT不改时间，取消／恢复复用原关系行，DELETE可清理本人正常墓碑或失效媒体的收藏。真实Redis并发／失锁、insert／取消／恢复SQL失败、ACK丢失有重试额度仍只提交一次，及12张交付／会话／草稿／财务表不变均验证。
- 实际审查修复两项P2：移除整读catch，DBtransport／rollback AggregateError保留原异常身份；无界attempt查询核对完整totalDocs，禁止用截断成功前缀误认交付，正常有界总数大于limit仍可读。两项均有实际RED→GREEN；坏快照／时间仍由局部纯校验给完整性503。ORM会先归一部分非法日历SQL值，不声称读取原始SQL日期即可完全核验；另验证纯非法日历和真实扩展年份。
- 主会话Node24.22.1最终独立全量449／449集成（保留407＋新42，16套）连续两轮、154／154单元（保留142＋新12）、SDK87／87、应用strict、新6源完整type-aware lint及15文件格式通过。测试图仍38条原外部header逐行同序／产品0，非全图通过；旧3源样式136条同基线，当前113 error／23 warning不算lint通过。
- 用同一套真实Redis／SQLite及S3协议适配、实际T1→worker交付21张fixture产物，证明批量级查询、同时间分页与第二SQLite连接中途改收藏的一致快照。模型及S3端点仍为明确本地fixture，协议测试不当作真实模型或微信真机。一次开发预跑native worker SIGSEGV原因未定；后续定向、实现者全量及主会话两轮全量均未复现，不宣称根因已修，未skip或修改原生依赖。
- 精确15文件SHA、原tracked／依赖、Taro与私包保护已主会话核对；环境文件未读、旧库未动、未切默认HTTP／运行档、未改UI或公开提交／推送。T07-B会话／轮次／任务inputAvailability与closed投影、T07-C积分面板、正式接口及客户端仍待实施。

## 2026-11-12 · T07-B1 最近会话与同快照草稿恢复

- 会话list/get用例、最小typed ports与DTO、Payload快照适配、会话游标与共享签名envelope分工；复用既有Artifact交付投影、草稿读取及原输入规则，不建通用CRUD／DI容器、不改资金／生成状态机。列表不逐会话读取全部任务／钱包；封面墓碑仍核全局tuple，inflight错链／软删／截断不伪装空摘要。
- 行为RED→GREEN包含分页／scope、真实21个正式creator空会话与唯一草稿、真实worker多轮封面及queued／running／unknown、同快照第二连接变更、失效媒体ID按原顺序保留、GET无写／Redis／S3／queue／积分查询。新增5种坏title先RED再复用名称规则仅校验，不改变原文；完整首轮478／479暴露原include列表断言遗漏，仅增新路径为第12文件后全过，不弱化断言。
- 根Node24.22.1独立复跑479／479集成（原449＋30，17套）、184／184单元（原154＋30）、SDK87／87、应用strict、新5源完整type-aware lint及12文件format通过；规格、质量独立审查均Approved。根提取前冻结的Artifact V1 saved真假两条wire逐字节兼容。
- 测试类型图在同cwd下仍38条完全同序外部header／产品0，实际exit1不算整图通过；本片旧3源完整lint仍原draft import排序1条、新增0，未声称旧源lint通过。本片与T07-A旧源集合不同，不比较两组绝对诊断总数。
- 冻结12SHA、Payload非写区171／Taro84／私包15及原tracked diff／依赖／HEAD均独立核验；根额外只改本验证记录和README。未读环境／旧库，无默认端点／运行档或页面接线、付费模型、部署或公开应用提交／推送。任务轮次／inputAvailability／closed及积分面板仍待后续；不是全产品或真机验收。

## 2026-11-12 · T07-B2 任务轮次与原输入恢复读侧

- get/list编排、页级身份／输入／交付投影、closed纯资金解析、具体batch ports和Payload snapshot适配分工；两个实际consumer复用原worker attempt loop及原Task input规则，不改变旧写语义或Library。数据库／网络错误原identity保留，GET不写、不取锁、不访问S3／模型／当前模板或草稿。
- 修正初始ASC方案不符“默认跟随最新”的问题：API固定roundNo DESC、cursor取更早轮；21实际T1／20真实worker交付证明首屏最近含queued，pure1000轮首屏只扫一次。未来客户端升序渲染、旧页前插保锚点仍待接线，不把API测试算页面验收。
- 实际覆盖原文字、多图顺序及缺图槽位；本人已知Task／Session正常墓碑可读但不恢复可写草稿，列表隐藏Task墓碑不压缩轮次。成功Artifact墓碑返回空ID而保原输入，物理缺失／错链／重复503；非成功出现任何Artifact亦503。活跃产物复用既有完整交付投影。
- closed仅从最小历史reservation／allocation／used grants及全局逻辑键／ledger前缀／closureaudit投影；两类释放按已存delta、不按今日到期重新分配。真实trustedClose证明A=1/E=1和zeroCost；wrong-association全局键、软删重复、额外capture、截断均503，不增加第二套结算事实。
- 根Node24.22.1独立复跑547／547集成（原479＋68，18套）、216／216单元（原184＋32）、SDK87／87、应用strict、新7源完整type-aware lint及13文件format通过；两轮独立审查Approved。测试类型图同cwd仍原38条完全同序外部header／产品0、exit1不是整图通过；本片旧2源原4条warning／0error，多重集前后一致，未声称全仓lint清零。
- 冻结13SHA与Payload非写区179／Taro84／私包15及原tracked diff／依赖／HEAD均独立核验。实际RED→GREEN包含strict query与running／unknown末attempt错误控制；两次坏测试fixture修正没有放宽产品断言。根只额外更新本记录与README，无公开应用提交／推送。积分面板、正式运行档／HTTP／Taro／真机与真实模型效果仍待后续，不算整体交付。

## 2026-11-12 · T07-C 积分余额、当前占用与历史流水

- 三个只读用例与两页投影分工，余额在同snapshot复用原readCreditAccount/reader，不构造带write的服务；列表只核本页资金图，不整钱包/N+1或加载生成输入／图片。configured是必填宿主同步布尔就绪，不代表模板可用／供应商在线；GET不建钱包、到期流水或结清任务。
- 两列表固定独立DESC游标，预留／解除不重复显示扣点；statusCredits仅reserve/release原分录amount，其余null，释放A/E来自原delta。真实131次受控grant与T1验证128分页和批量取used grants；历史reserve在capture/release后仍可读，zeroCost占用不制造零额流水。source来自原grant；没有支付／revoke写流程，未准入revoke记录明确失败不静默隐藏。
- 根Node24.22.1独立全量615／615集成（原547＋68，19套）、244／244单元（原216＋28）、SDK87／87、应用strict、新6源完整type-aware lint及12format通过，规格／质量Approved。额外2定向ORM/计划测试pass、66skip单独记录，不混全量数量。测试图仍38条完全同序外部header／产品0、exit1不是整图通过；本片旧2源57诊断（45error12warning）相同import graph根实测前后多重集一致，不声称全仓lint清零。
- 实际捕获Payload SELECT再EXPLAIN，两OR分支分别使用user/status或account/status、user/createdAt或account/createdAt索引；仍需临时排序B树。两新增普通索引不含UNIQUE/FK；私有评审DDL已独立内存核27表／67索引／8基础字段，不是迁移。
- 保留真实ORM坏review_after case：framework日期反序列化先RangeError，服务原identity及零写；纯投影非法UTC另503，不用粗catch改写基础设施错误。真实入账amount与delta同步污染、expire空／超issued的负例与mutation RED→GREEN，wrongassoc/deleted/globalkey/truncation、second连接一致性、schema零IO均覆盖。
- 冻结12SHA、Payload非写区188／Taro84／私包15及原tracked diff／依赖／HEAD根独立核验。交接patch初版因lint镜像symlink漏6新源，baseline元数据未错；根保留原件并重建完整8新＋4旧patch，临时树apply后12SHA一致，未改产品源码。根只另更新本记录与README；没有公开应用提交／推送、默认HTTP／身份组合根、客户端、真实付费模型或部署验收，完整闭环继续推进。

## 按数据影响选择验证

- **单元与边界**：仓库根执行 `pnpm product:test`。测试内使用 mocks／临时文件；不能代替真实数据库和模型验证。
- **类型检查**：`pnpm product:typecheck` 会先构建框架声明和缓存。先满足 Node／pnpm 要求，不把它当作只读检查。
- **生成 HTTP 隔离测试**：`pnpm --filter @heymoro/server test:creation-http` 创建系统临时目录和随机端口，显式覆盖数据库／上传目录、关闭自动任务并清空真实密钥，使用 fixture；脚本结束清理临时数据。Next 构建产物留在应用目录。
- **后台 HTTP 隔离测试**：`pnpm --filter @heymoro/server test:admin-http` 创建 `.data/admin-acceptance-*` 与随机端口。结束停止服务但保留数据库、上传物和日志；并非自动清理的系统临时目录。脚本继承部分进程环境，不用于证明模型环境已隔离。
- **旧账号实验**：`pnpm --filter @heymoro/server test:unified-spike` 使用独立 host、随机端口与 `.data/unified-spike-*`。它会复制 `src/app` 至测试 host 并保留实验数据，不是当前默认验收，不做存量迁移。[旧方案](https://github.com/Heymoro/product-lab/blob/main/products/heymoro/archive/identity-design.md)／[实验记录](https://github.com/Heymoro/product-lab/blob/main/products/heymoro/archive/identity-validation.md) 在私有资料库。
- **客户端 fixture 服务**：`pnpm --filter @heymoro/server dev:creation-fixture` 使用临时数据与测试图片，最长运行 30 分钟；结束清理临时数据，不代表真机或真实 AI 验证。

## 首次启动：会创建本地环境

以下仅供后续获准运行时使用，不是本轮待执行工作。先满足运行版本，再确认应用专属数据路径；不要复用框架测试数据库。

```sh
# 在 Payload 仓库根目录执行
pnpm install --frozen-lockfile
pnpm --filter @heymoro/server setup:local
pnpm --filter @heymoro/server generate:types
pnpm --filter @heymoro/server generate:importmap
pnpm product:typecheck
pnpm product:dev
```

`setup:local` 创建 `.data/uploads` 及权限 0600 的 `.env.local`，已有配置不覆盖。生成类型／import map 会改文件。新数据库通过 Payload 首次管理员流程初始化；不 seed 测试账号、不自动登录。服务连接配置数据库，开发启动亦可能写表。

既有 README 记录曾用 SQLite backup 复制手工联调数据库至 `.data/heymoro.sqlite` 并复制上传物；这是迁移时的历史操作，不是每次启动步骤。旧数据保留，不自动删除副本或历史账号。产品配置拒绝 `PAYLOAD_DROP_DATABASE=true`。

## 指向现有服务的 HTTP 与重启测试

**这些测试写入当前配置目标。** `test:http`／`test:mvp-http` 读取应用 `.env.local`，并连接其中的服务地址。只能在已核实的本机 mock 测试服务运行；建议使用可丢弃的独立数据库、上传目录及密钥。测试用户与审计会保留，记录／文件清理不等于还原数据库。

```sh
# 在仓库根执行；先另行启动确认过目标的应用
pnpm --filter @heymoro/server test:http
pnpm --filter @heymoro/server test:mvp-http
```

重启验证在 `apps/heymoro` 内执行，两阶段保持同一隔离数据库、上传目录和密钥。`HEYMORO_PERSISTENCE_STATE` 仅指定阶段状态文件，不会自行切换数据库；先确认服务及环境隔离。

```sh
node --env-file=.env.local tests/persistence.mjs prepare
# 停止并重新启动同一隔离应用
node --env-file=.env.local tests/persistence.mjs verify
```

队列命令 `jobs:creation` 可能调用付费模型，环境变量 `HEYMORO_JOB_AUTORUN` 控制应用内队列定时运行；不要在日常检查中顺手执行。fixture 测试不证明真实模型费用、超时或图片效果已验收。

## 2026-11-11：本次资料整理复核

- `pnpm product:test`：48 项通过，0 失败；这是当前本地代码的单元／边界测试，不是接口或真机验收。
- 92 个既有源码、测试、脚本及配置文件 SHA-256 未变；既有 tracked diff 未变，Next 自动生成的维护说明完整保留。
- 本次涉及 7 份文档，27 个相对文件链接有效；文档引用的应用及根命令均能在 package scripts 中找到。
- 私有账号历史材料已归档并发布至 `product-lab` 提交 `a0e90c2`，确认远端后才移除应用根目录原件。
- 未运行 HTTP 测试、类型构建、真实模型、迁移或真机验证；Node 24.20.0 低于框架要求 >=24.22.1，单元通过不解除运行环境差异。

## 历史工程记录（原 README 摘录）

以下保留迁移与早期功能的原记录，不重新授予开发权限。文中的“本轮”“当前”“已通过”均指当时记录，**不是 2026-11-11 的复验结论**。其中旧文件名仅为历史引用，现行入口见文首与工程 README。代码基线内的固定试用额度不是新版积分系统。

### 迁移边界

20 个业务源码文件从 `_community` 原样迁入 `src`，来源和原始 SHA-256 见 `tests/migration-manifest.json`。原样迁移检查已在迁移验收时通过；现进入业务迭代，原始哈希保持归档，测试改为来源清单验证，不静默重算历史哈希。

`test/_community` 仅保留测试配置和回归，单向引用这里的实现。应用不导入测试助手、测试凭证或测试配置。类型和后台 import map 由本应用配置生成。

框架 exports 指源码，应用严格类型检查通过 project references 消费按框架自身配置生成的声明；应用保持 strict，不关闭构建错误检查。产品包使用本仓已有 TypeScript 7 CLI，其他框架工具继续沿用原有 TypeScript 配置。

### 本轮验证记录（2026-11-01）

- 业务源码 20 文件原始 SHA-256 一致。
- 应用边界与配置测试 7/7；原集成回归 7/7（独立临时 SQLite）。
- 严格 typecheck 通过，框架以声明文件参与检查，未禁用 strict。
- 本地 HTTP 登录/记录权限/上传下载/引用保护/退出回归通过；重启后记录与会话保持。
- `pnpm build:check` 通过：类型检查及 compile 模式编译；不是完整生产构建。
- 完整生产构建：编译和类型阶段通过，页面数据收集因生产禁止 mock 而失败；未绕过限制。
- 依赖安装有既有 engines 警告：当前 pnpm 使用 Node 24.20.0，框架声明 >=24.22.1。上线前需统一到满足声明的运行时，本轮不宣称生产兼容验收。

### MVP 增量回归

启动开发服务后执行 `pnpm test:mvp-http`：覆盖资料更新/回读、记录部分编辑/回读、附件替换/解除/越权、中文文件下载、21条记录与3个文件的跨页遍历、分页参数拒绝。仅本机mock可运行；退出前删除记录、排队文件删除并撤销会话，保留审计与测试账号。

本轮修正中文 Content-Disposition 头和分页有限正整数校验；其余业务接口直接复用。迁移原始哈希不变，不再以旧哈希限制产品源码后续开发。

### 本地 MVP 权限及清理补齐

`pnpm test:admin-http` 自动启动隔离端口、独立 SQLite 和上传目录，验证空库首账号为管理员、最后管理员保护、运营隔离、旧 JWT/业务会话停用失效、会话到期、55文件批次清理、目录权限失败重试和管理员并发变更。只在脚本自己的新数据库中模拟到期和历史文件时间；不读取/修改开发库。

管理员 bulk 修改/删除明确禁止，逐个操作并使用本地 SQLite immediate 事务；这不是其他数据库/多实例部署已通过的证明。身份/会话原始集合不开放公共读写，认证服务内部 override 不变。清理不再把独立 active 文件当作 orphan；仅处理明确删除的 pendingDelete。

后台管理与用户端的账号、权限和人工验收边界见 [后台权限边界](admin-access.md)。两端按职责区分入口与操作权限，不要求普通用户另注册后台账号。

已有账号内部实验可执行 `pnpm test:unified-spike`，证据及限制见 [历史账号实验记录](https://github.com/Heymoro/product-lab/blob/main/products/heymoro/archive/identity-validation.md)；当前应用仍使用原认证配置。这些资料不是独立迁移项目，不阻塞小程序 MVP。

### 原生文件URL本地兼容修复

现有next.config的Node服务端external从Payload上下文解析file-type，并保留原生ESM动态加载；withPayload原有serverExternalPackages声明仍保留。此处处理pnpm工作区解析差异，不重写下载/内容校验，不改存储或账号，不向小程序加入后台功能。

原生PDF/JPEG/PNG读取、PDF Range、角色与生命周期断言纳入test:admin-http，不再排除原500路径。最终结果与本地限定范围见Taro应用MVP_STATUS.md；本轮未验证Turbopack、Edge执行、standalone迁移或正式发布。

### 图片创作闭环

服务端提供 `/api/v1/creation-sessions`、`/generations`、`/artifacts`、`/creation-account`。
所有创作接口仅接收 active 业务用户；原生 REST/GraphQL 禁止写会话、任务和 jobs。客户端仅传模板 ID、补充描述、本人参考媒体 ID 和 `clientRequestId`；模板指令仅存在服务器。任务 DTO 的 `provider` 标记 `openai` 或 `fixture`。

服务端环境变量（不要放到客户端）：

- `OPENAI_API_KEY`：真实 OpenAI API 密钥。缺失时账户 `configured=false`，创建任务返回 `503 GENERATION_NOT_CONFIGURED`，不预留额度。
- `OPENAI_IMAGE_MODEL`：默认 `gpt-image-1.5`。每次一张 PNG；有参考图时用 Images edits multipart `image[]`，无图用 Images generations。
- `HEYMORO_JOB_AUTORUN=false`：关闭应用内 jobs 定时运行。默认每 10 秒运行 `creation` 持久队列；长期运行的 Node 服务可直接使用。独立 worker 可运行 `pnpm jobs:creation`（运行前显式注入同一服务器环境）。不要在 serverless 进程依赖内置 cron。

每个用户首次试用总共 2 点。创建任务和队列入库同 SQLite 写事务；queued/running/unknown 预留，只有输出媒体及 succeeded 状态同时提交后才消费。明确失败释放；网络超时、上游 5xx、存储不确定或过期 running 保留预留并标记 unknown，禁止自动重跑收费请求。unknown 需运营核验上游状态后再人工处理，当前无客户端重置或退款接口。单用户最多一个在途任务。

新任务 `201`，同 owner+clientRequestId 同快照重试 `200`；快照不符 `409 IDEMPOTENCY_CONFLICT`；在途 `409 GENERATION_IN_PROGRESS`；额度不足 `402 CREATION_CREDITS_EXHAUSTED`。输入限 8 张本人 active JPEG/PNG，单张 10MiB、合计 32MiB；描述最多 2000 字；仅 free 模板允许无图。

验证：`pnpm test`、`pnpm typecheck`、`pnpm test:creation-http`。HTTP 用例自行创建临时 SQLite、上传目录和随机本地端口，不依赖或修改 `.env.local`（关键运行变量显式覆盖、真实 API key 清空），不接触手工数据，结束时清理临时数据。仅该自动化用例显式设置 `HEYMORO_IMAGE_PROVIDER=fixture` 和 `HEYMORO_AUTOMATED_TEST=true`；生产拒绝 fixture。fixture 产物是不同于原图的测试 PNG，不代表真实 AI 验收。

客户端集成测试可运行 `pnpm dev:creation-fixture`：自动选择端口，输出 fixture 标识、baseUrl 和清理 PID。终止启动器会停止服务并删除临时数据；最长 30 分钟。仅用于自动化集成，不用于真实 AI 或真机验收。

## 2026-11-12 · D1 正式运行档与实际组合根

- 默认根真实导入正式builder，配置限工程外显式有界JSON；缺配置先于数据库连接拒绝，无旧数据库／上传／mock默认。只在明确development/test初始化全新目标，由Native push建schema；ready运行push:false，connect／WAL之前只读校验完整schema，不修复旧库。schema-ready与provider健康分离，不能据此判断整个应用可用。
- 原生身份定义扩展标准审计／删除与同gate写门禁，保留Native认证及框架内部约束；真实payload.auth验证严格opaque业务令牌、最小principal、失效身份与管理员JWT分离。正式服务与双Native jobs共用同Payload实例runtime，CLI直接getPayload，不走Payload CLI环境加载器。Redis／S3构造零网络、首次操作验证及幂等关闭；命令／存储在途操作完成后才关闭自有资源。
- 真实组合测试使用official test.suite与正式builder，测试侧受控种子不暴露在服务bundle：publish→session／draft／quote／T1→Native生成job→Artifact／结算→Native命名job，以及重放、unknown与各查询／收藏入口。供应商为明确host DI／环回fixture，无真实模型费用，不冒称微信登录或真机流程。
- 规格及质量独立审查各修复两项实际缺陷，均有RED→GREEN：SQL注释伪装自增、S3数字bucket、初始化环境错放行、Redis close漏等在途命令。最终复审通过；没有新增通用CRUD、DI容器或Native DDL生成器。
- 主会话在最终20文件SHA上独立通过277／277产品单元、628／628隔离集成（21套）、应用strict、10个完整type-aware lint目标（新7源＋2script＋实际默认根）、20文件格式；SDK87／87且源码保持。质量修复前另一次根全量628／628，不合称同SHA连续验证。测试类型图仍38条完全同序既有外部诊断／产品0、实际exit1，非全图通过。 根另用真实Native目标验证同名索引collation／DESC／表达式漂移3／3拒开且DB／manifest SHA保持；这是独立诊断，不累加到628。
- **原生稳定性仍未闭合**：实现者两次全量601／628后owner-task-history worker SIGSEGV；根排除D1两suite的旧19套控制组601／615后同类崩溃。原suite定向68／68；D1前旧crash与本轮macOS栈同为libsql native→NAPI finalizer。2000事务／GC探针未复现，未确认根因或已发布补丁；后续通过不代表修复。不skip／改旧断言／盲目升级依赖；继续单独隔离定位，不能给出稳定可交付结论。
- 根实际重建原始字节并在自有临时树应用完整patch，20／20结果SHA一致。原非写区Payload193／Taro84／SDK15、tracked diff／依赖／HEAD均保持；package仅scripts变化，根另维护现有工程文档。未读取环境文件或存量库，未迁移、运行生产、改UI、公开stage／commit／push。
- 下一关卡仍为微信身份写／试用权益与bootstrap、薄业务HTTP／真实Next无环境文件隔离启动、multipart实际流、Taro系统选图／创作／作品收纳、布局与真机，以及本地完整构建；本片不替代这些验收。

## 2026-11-12 · D2-A 正式身份用例与首次权益

- runtime增加login／authenticate／getMe／updateProfile／logout，Native User策略共用只读身份规则与reader；专用Native仓储持有同gate与UOW，不扩通用CRUD，不改原认证关系／unique或资金writer。`identity`政策显式必填，无默认2点／7天，WeChat暂停只停新换码，不使现有有效会话失效。
- 正常adapter固定官方换码地址、禁重定向／重试、实际流字节与整体deadline；用可信host供应商替身测试，无真实微信上游请求。A身份＋Session＋audit原子提交，动作auth.wechat.session.create不冒称token已交付；释放身份租约后B确保fixed trial key。A/B未确认不自动补偿删除或重发code，B失败用新wx.code恢复，原款始终按原参数重放。
- 定向Native测试使用official fixture与正式builder，覆盖并发归属／union隔离、四写点与audit故障回滚、失锁、A/B确认丢失、新code恢复、policy变动／null／到期／真实生成消费后重放、profile/logout禁用竞态、坏证据与保留Native约束；供应商明确是假换码／fixture图片engine，不冒称真实微信身份或模型效果。
- 规格及质量审查通过。根在最终17文件SHA、指定Node24.22.1独立通过370／370产品单元、41／41新增Native定向、669／669完整集成（22套，已包含这41项）、SDK87／87、应用strict、新6＋runtime4完整type-aware lint、17文件格式。测试类型全图仍38条精确同序原外部诊断／产品0、实际exit1，非全图通过。
- 原生风险仍保留：实现者full657／669时owner-credits worker SIGSEGV，随后同file定向48／68再SIGSEGV即停止，没有第三次追绿。根独立核新macOS栈与D1前六native偏移一致；根后来一次full669通过，不作为根因修复或稳定运行证明。未改框架／依赖、skip或放宽旧断言。
- 根按原始9新／8旧字节在自有临时树实际检查和应用完整patch，17／17结果SHA相同；原非写区205Payload／84Taro／15SDK、tracked diff／HEAD与空暂存保持。根另维护现有工程文档／私有资料；无生产、存量迁移、环境读取、公开应用stage／commit／push或UI改动。
- 当前默认HTTP仍health-only。D2-B host管理员bootstrap、E身份／业务路由／实际multipart与取图／server trace关联／Next隔离冷启动、Taro四组件和工作流、完整构建与真机仍待实施，不因身份内部用例通过宣称整个产品可交付。

## 2026-11-12 · D2-B 宿主管理员命令

- 严格bootstrap／create／update、同admin-management协调资源、同owned req的NativeJWT鉴权／密码及session规则、last-admin、最小DTO／私密audit已接线；没有HTTP管理端点或任意Local API能力。共享private JSON只服务两个真实入口，保原配置语义并覆盖finally close脱敏；CLI先验证输入，再打开ready目标，不初始化、迁移或重放unknown。
- 规格审查发现Native connect在onInit前失败会遗漏资源。实际行为RED后，只在本CLI的sanitized db.init捕获owned Payload，finally在destroy前保存client；14项unit覆盖该失败、onInit、confirmed-cleanup与unknown，规格及质量独立复审通过。
- 根在最终12文件SHA、指定Node24.22.1独立通过384／384单元、25／25新增Native定向、SDK87／87、应用strict、7源完整type-aware lint及12format。测试类型图仍38条精确同序原外部诊断／产品0，实际exit1，不计全图通过。
- **全量门禁待验**：实现者v1全量693／694、exit1，旧真实MinIO Docker run超时；根v2只读docker version也4秒超时，未再次launch容器或把旧结果当最终全绿。只读容器inventory亦超时，未见对应launcher但容器残留未确认；不操作daemon或未证归属容器。待可确认服务状态后再执行最终根全量。
- 两个故障CLI child原先连续打开／关闭父同库后出现IOERR_SHORT_READ，因果未确认；故障用例改用自有Native VACUUM INTO一致ready快照，正常同库CLI用例仍保留。该隔离不是底层修复，D1-R finalizer风险继续开放；不skip、换依赖或改框架追绿。
- 根独立按原始7新／5旧字节重放完整patch，检查／实际apply及12SHA均吻合；217Payload／84Taro／15SDK非写区、tracked diff／HEAD与空暂存保持。现有工程文档由根另行更新，无公开stage／commit／push。
- E0计划已复审，且仅有synthetic OS deny能力探针通过；尚未运行真实Next。业务HTTP、multipart／取图、客户端四组件与工作流、完整构建／真机仍待，不把本片作产品交付。

## E0R · 正式Next隔离启动与配置兼容

- 实际Next／Webpack请求先返回500：`runtime/config.ts`的目录`new URL`被解析为资源依赖。产品源码仅将`projectRoot`改为Node路径计算，保六级父目录／尾分隔符／导出与原配置语义；没有改Next配置、框架、业务schema或依赖版本。
- 固定源码清单通过canonical排除规则的rsync dry-run＋stats后复制，只有一个约13.9MB的源码副本；副本内依原锁、忽略scripts、copy导入重建SDK／框架与运行依赖，不复用原node_modules／缓存。联网仅用户明确批准的公开npm安装阶段，模型／命名／微信／Redis／S3调用关闭。
- 原工程禁写、旧data／.env内容禁读；每Node实际native正负探针与guard握手，官方TS7独立子组有外层kernel归属及有限ACK。信号前持久化输出与身份，zombie等父reap；未知归属或未确认清理不恢复。全owned源码与runtime分别计量，根复验前runtime约2.96GB；未自动删除或轮转源码／依赖／缓存。
- 规格及质量独立复审通过。根在最终4SHA用新验证epoch独立执行ready-attest＋两次新Next进程：两轮真实`GET /api/v1/health/ready`均200／database=ok／UUID，实际compiled root及JSON路径正确；每Node／子组证明及所有PID／PGID／端口退出确认。旧passed报告SHA不变，未复制、安装、构建或重新初始化；保留cache，因此不是cold build。
- 根fresh回归：384／384单元、25／25管理员Native定向、SDK87／87、应用strict、4文件format与316规则完整type-aware/type-check lint通过。测试图仍38条精确同序既有外部诊断／产品0、实际exit1，非全图通过。完整3新／1旧patch内存应用与4SHA一致，反向检查通过，无额外源码副本；228原非写区Payload＋1授权const、84Taro／15SDK及tracked diff／HEAD／空暂存保持。
- 单次初始化的新ready目标在后续只作完整schema attestation；唯一config源修订有显式old→new SHA及owner revision，next-env只允许已证Next自动生成的两项类型路径overlay。旧offline／DNS／输入缺失／进程证明／Webpack500失败均留存，没有倒填通过。
- 边界：默认业务仍health-only。身份／生成／multipart／私有与示例取图、Native Users读DTO边界、客户端／真机、完整build/start仍待；D2-B最终MinIO全量门禁与D1-R原生风险仍开放。此处没有真实AI效果或整体交付结论。

## 2026-11-13 · E1A 身份 HTTP 与服务端追踪

- 默认正式builder注册微信换码、本人读取／昵称更新、会话撤销四个薄端点；业务规则仍在原身份服务。UserDTO不含审计／凭据，Native Users REST／GraphQL／me裸记录读取封闭，管理员原生约束保留。
- JSON实际字节最多16KiB、整体5秒、严格UTF-8；身份query及非空GET／logout拒绝。业务v1路由在Payload dispatch前拒绝两种方法覆盖header，避免框架先无界读体；非v1原生路由保留。
- server UUID贯穿响应body／header和对应三类身份审计；204无body。忽略客户端追踪header，可信独立参数在重试外固定；首次trial的独立资金审计不冒充身份同一事务。未知异常不回传原始字段。
- 规格审查实际抓到terminal read在微任务延后时越过deadline的P2：v1真实5102ms错误成功；补RED回归，仅在await之后、done/value之前再校单调时钟。v2同实际源5103ms受控超时并解锁。保留v1失败／通过证据，未倒填v2成功。
- 最终规格及质量复审通过。根独立fresh：410／410单元、88／88官方Native定向、SDK87／87、应用strict、18文件format通过；15逻辑／新测试／配置文件316规则完整type-aware/type-check lint为0。全18文件lint仍414条旧三spec诊断，与获准oldbytes原位overlay结果逐项多重集相同；不计全18lint绿。测试图仍38条精确同序外部诊断／产品0、实际exit1，非全图绿。
- 最终18SHA／完整patch内存应用及reverse check一致；v2仅请求reader和单测两个文件异于v1。选定原非写区223 Payload／84 Taro／15 SDK、原tracked diff／HEAD／空index保持；根另仅维护本工程两份说明与私有产品资料。未复制源码、安装依赖、更新E0目标或公开stage／commit／push。
- 以上HTTP走官方test.suite及真实Payload／Next路由函数，WeChat为可信host替身；不是运行中的Next服务器、真实微信或小程序真机。E1后续生成／媒体／收纳、实际Next业务HTTP、T08–T09仍待，D2-B MinIO全量与D1-R原生风险保持开放。

## 2026-11-13 · E1B 目录、会话与草稿 HTTP

- 新增公开模板列表／分类标签／详情／自由预设，以及本人创建／列表／详情／重命名／草稿读写十个端点。复用同runtime既有服务；创建仅返回七字段DTO，201新建／200回放，不透传raw SessionRecord或拼造空封面／运行状态。owner仅opaque凭据，不信req.user或输入的归属字段；完整性错误503，不吞成401。
- 第二组真实消费者提炼共用reader／响应／trace。身份正常四路由AUTH_*码保留；仅v1方法覆盖前置拒绝明确统一400 INPUT_INVALID。raw URL严格单次解码／拒重复及未知query，Native测试直接使用原始Request＋真实REST_GET，避免RESTClient qs往返将坏查询规范化。GET带body仅direct adapter＋实际流测试，不称网络GET。
- 默认16KiB适用于身份／创建／重命名；草稿明确128KiB，支持宿主已允许的10000 UTF-16单元文本及最坏JSON转义。可信maxBytes须正安全整数、消费前校验，客户端不能选预算；同5秒、实际字节、fatal UTF-8与取消解锁。领域图数／文字／媒体权限上限不变，草稿可未完成，保留原文与图片顺序。
- 规格及质量独立审查通过。根fresh在最终21SHA通过435／435单元、8文件194／194 Native定向、SDK87／87、应用strict和21文件format；18逻辑／新测试／配置完整316规则type-aware/type-check lint为0。全21仍414条旧三spec诊断，与本片变更前fresh完整基线的归一化多重集一致，非全lint绿；测试图仍38条同序外部诊断／产品0、实际exit1，非全图绿。
- 凭据重复503用例是一次性owned fixture运行中的schema故障注入：临时移除tokenHash Native UNIQUE索引、复制行，finally删除重复并await恢复原索引SQL。正式UserSessions源码及认证约束保留，测试不证明正常schema允许重复；删除／恢复失败会使测试失败，强制中断不承诺修复临时目标，更不是旧库恢复工具。未改产品DDL、依赖、框架或Taro。
- 根核完整正向patch内存应用21SHA及reverse check，原选定228 Payload／84 Taro／15 SDK、tracked diff／HEAD／空index保持；根只另更新现有工程说明与私有资料。没有新源码副本／安装／初始化E0目标或公开应用stage／commit／push。
- 当前新HTTP证据为官方fixture和真实Native路由函数，微信为可信host替身，草稿媒体为已上传元数据fixture，不是multipart或模型生成验收。实际Next业务HTTP、上传／取图、报价／受理／历史、收纳／收藏／积分、T08–T09仍待。根只读确认本机unix Docker context，但version查询4秒仍超时；未启动／清理容器，MinIO最终全量与D1-R原生风险保持开放。

## 2026-11-13 · E1C 图片字节、收纳与积分 HTTP

- 默认组合根新增3个媒体及7个作品／收藏／积分端点，共25个自定义端点。本人上传是一图一请求、唯一File字段；平台解析前限制实际wire bytes为单图上限＋16KiB，另检查File大小，共享30秒单调期限与abort。固定有限bytes的平台解析不承诺CPU抢占或恒定内存；不使用框架兼容上传指令、自写multipart解析或临时文件。
- 共用reader立即快照每个chunk。根实际Request／共享buffer探针先得到错误`[3,4,3,4]`（RED），最小copy修复后得到`[1,2,3,4]`且body解锁（GREEN）；JSON原16KiB／5秒与draft128KiB／5秒边界保留。坏图只在decoder调用处转INVALID_MEDIA，不吞S3或登记提交不明。
- 私有字节读取复用S3前后用户／媒体事实核验，返回前再验证同一opaque凭据，覆盖在途撤销／到期；官方示例仅official有效记录。二进制返回实际mime／length、安全固定inline文件名、nosniff／private no-store／服务端trace；失败为JSON，不带图片头。DTO不含桶／key／URL。输入图遵守host caps，生成输出保留global策略；零图宿主合法，但上传入口不读body即拒绝。
- 本人收纳、详情、方法决定的收藏／取消及积分面板／占用／流水直接沿用既有服务和DTO。真实HTTP游标覆盖21项分页及501墓碑空页续查；积分读取不建钱包或跑过期，真实grant过期后的reservation仍列出，known-not-sent结算按原allocation释放并核对delta。测试使用官方test.suite、同runtime gate、实际身份／受理／worker与S3环回字节；未伪造Artifact响应。
- 规格及质量独立审查通过。根fresh在最终19SHA通过472／472单元、12文件232／232 Native定向、SDK87／87、应用strict及19文件格式；16逻辑／新测试／配置文件完整type-aware/type-check lint无诊断。全19lint实际exit1，414条旧三spec诊断与变更前fresh基线归一化多重集相同；测试图实际exit1，38条同序外部诊断／产品0，均不算全绿。
- 根独立对完整19文件patch逐hunk内存应用并反向还原，与19SHA一致，git reverse check通过；原非写区238 Payload／84 Taro／15 SDK及tracked diff／HEAD／空index保持。根另更新既有工程说明与私有资料；没有新表／依赖／框架修改、新源码副本、安装、E0初始化或公开应用stage／commit／push。runtime测试配置仅批准clock／受控engine结果和局部必要style；旧三spec不作广泛格式修复。
- 按用户本轮明确批准，仅清空唯一E0验证目录下下载缓存叶子`pnpm-store/v11/files`和`home/Library/Caches/pnpm/v12/{metadata,metadata-full}`，释放1,517,559,808 bytes，之后可用约11.6GiB。删除前核验归属、非缓存链接和占用；78,857个非缓存regular／symlink元数据项及旧passed报告SHA保持，不删除源码、已装依赖、数据库、历史证据或PNPM项目注册链接，不停进程。原历史无删除声明保留为此前事实；本次是单独授权的下载缓存例外，不表示缓存仍温热，也不新增自动清理规则。
- 证据：本机`/tmp/heymoro-E1C-root-{verification-results,replay,comparison,protection-before-docs}.json`、`root-chunk-alias-{red,green}`日志及`cache-cleanup-result.json`；临时路径不作为唯一交付记录，本文保留范围与结果。当前仍未验证实际Next业务HTTP、报价／受理／历史端点、新版Taro／真机、真实微信或付费模型；完整MinIO门禁及原生libsql finalizer风险仍开放。整体Goal保持active。

## 2026-11-13 · E1D 报价、幂等受理与任务历史 HTTP

- 默认组合根新增五端点，共30个自定义端点：普通／再生报价、生成受理、来源Artifact换一张、任务详情及会话轮次。先验证opaque业务身份，三POST复用128KiB实际JSON字节／5秒期限；quote两形态互斥，缺input明确400，不读取草稿兜底。模式、版本、媒体归属、报价与资金仍由原admission服务决定，未改domain／application／schema或依赖。
- 受理data直接原十字段TaskDTO，isNew仅决定201／200，不返回内部封套或伪造artifactIds，也不在提交后追加历史读取。任务GET／列表直接原16字段历史DTO，保留availability、closed释放投影、roundNo倒序及真实cursor；取消收藏或下载失败不改变任务结算。
- 根提前复现幂等键被HTTP trim合并的RED，原`  stable-request  `错误变为`stable-request`；最小修复只用trim判全空白，按原长度至多128并原值传递，根GREEN同时核对原长129拒绝及quoteToken原文。没有修改服务的既有幂等规则。
- 首次全unit实际475／476失败，原因是旧protocol反例把本轮已合法接通的GenerationError CREDITS_INSUFFICIENT仍当未知500。根核原SHA及断言后批准唯一第11文件扩展，只将该code改UNKNOWN_GENERATION_CODE，500／脱敏断言保持；原10文件v1 freeze／patch及失败日志保留。v2原10SHA全部相同，仅增加此一字面量旧单测修正，不倒填v1通过。
- 新Native六个大用例覆盖同runtime／gate真实发布effect、本人多图HTTP上传、free文字、quote／201受理、显式Native jobs、历史／成品取图／收藏／积分、改草稿后按来源换一张、并发／在途／同键冲突、已受理过期报价回放与未受理过期拒绝、越权及三个POST恰好128KiB／加一、21真实轮次HTTP游标／墓碑。quote／admission无模型调用，job为明确零费用engine fixture；旧owner-task-history另复验closed与有界空页，不伪装本片HTTP生成501条。
- 规格与质量独立审查Approved。根fresh：476／476单元、15文件332／332 Native、SDK87／87、应用strict、11文件格式与8逻辑／新测试／配置完整type-aware/type-check lint通过。全11lint实际exit1，仍旧三spec414诊断，与本片前置fresh基线归一化多重集一致；测试图实际exit1，只追加新Native，仍38同序外部header／产品0。没有弱化规则或把这两项算绿，也没有重试原生崩溃来追绿。
- 根逐hunk正向内存应用和反向还原完整11文件patch、Git reverse check及11SHA匹配。原非写区250 Payload／84 Taro／15 SDK、原tracked diff／HEAD／空index保持；根另维护两份既有工程说明和私有产品资料。未新复制源码／安装、初始化E0目标、改框架／依赖／schema／Taro或公开应用stage／commit／push。
- 证据在本机`/tmp/heymoro-E1D-v2-root-{verification-results,replay,comparison,protection-before-docs-v2}.json`，根原值探针`/tmp/heymoro-E1D-root-request-key-{red,green}.{log,exit}`；当前文字记录保留结果与边界，不以临时路径作唯一交付。实际Next业务、真实微信、付费模型效果、新版Taro／真机／完整build仍待；根只读重查desktop-linux本机unix socket，Docker server version仍4秒超时，未启动／清理／重启服务或容器。D1-R原生finalizer及D2-B MinIO最终门禁继续开放，整体Goal仍active。
