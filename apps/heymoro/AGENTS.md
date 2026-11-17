# Heymoro 应用维护边界

- 本应用是 Payload workspace 的产品承载目录；框架包与 `test/_community` 不是产品实现入口。应用不依赖测试凭证或测试启动器。
- 用户于 2026-11-12 明确批准本地核心闭环实施。按私有资料库当前实施 TODO 分阶段开发与隔离验证；该授权不包括生产部署、真实支付、存量数据迁移或批量提交其他既有改动。
- PRD、Figma 链接、产品技术方案、评审 SQL 与类图唯一来源是私有 `Heymoro/product-lab/products/heymoro`。工程 README 只做链接，不复制或另建版本。
- `docs/` 仅保留与代码相关的运行验证及权限说明；旧产品方案在私有资料库归档，不作为现行路线。命令存在和历史成功记录不等于当前验收通过。
- 运行命令前检查 README 的影响说明、Node/pnpm 版本、目标服务与数据库；`typecheck` 会生成框架产物，HTTP 测试可能写库，队列可能产生真实费用。
- 不读取或输出密钥；不提交环境文件、账号、数据库、上传物与日志。不清理未识别的既有数据。保留其他工作中的未提交修改。
- 本仓公开；产品设计与团队实验资料不随工程自动提交或推送。提交只包含明确范围，检查生成文件及暂存内容。

<!-- BEGIN:nextjs-agent-rules -->

## This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
