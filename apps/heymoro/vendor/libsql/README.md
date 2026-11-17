# libsql 0.4.7 · Darwin arm64 稳定性回移植

仅修复当前本地 Mac 原生连接的重复关闭；不升级 `@libsql/client`、SQLite 表结构、Drizzle 或 Payload，不改业务事务。

## 来源与范围

- 原 binding：`libsql-js` v0.4.7，commit 与源码归档 SHA 见 `provenance.json`。
- 原 Rust 依赖同样存在释放后未清空指针的问题。回移植[上游已合并修复 #2261](https://github.com/tursodatabase/libsql/pull/2261)：`sqlite3_close_v2` 后把 `self.raw` 置空，使随后 Drop 不再访问旧句柄。
- 精确 override：`libsql@0.4.7>@libsql/darwin-arm64`。它影响本 workspace 中共享该驱动的消费者，不是仅因为目录在 app 下就“应用私有”。其他平台仍使用原依赖，**本补丁未验证或修复其他平台**。
- 最低 macOS 13，N-API 6；只链接系统动态库，install name 为 `@rpath/libsql_js.node`；使用临时 ad-hoc 签名，不需要私钥。MIT 许可证随 tarball 提供。
- 安装只解包已核验 tarball，不在 postinstall 联网或编译。官方兼容稳定版修复并通过本地验收后，应移除此回移植。

## 重建与验证

Python 3.12+、已安装且版本匹配的 Rust stable、Xcode CLI 工具可用后，显式执行：

```sh
python3 apps/heymoro/vendor/libsql/rebuild.py --output /absolute/new-build-directory
node --expose-gc apps/heymoro/tests/native-driver/verify.mjs --runs 8 --cycles 2000 --output /absolute/new-test-directory
```

重建仅写新目录：核验固定源码／便携 CMake 的 SHA，原始源码断言失败 → 同一断言修复后通过 → 删除诊断导出 → 编译原 N-API 接口。限制 20 分钟、4 GiB 子进程 RSS、3 GiB 构建目录及 2 个构建任务；失败保留证据，不自动清理。首次编译还会按原 Cargo.lock 获取 Rust crates；不升级其版本。

脚本输出新 `index.node` 和构建回执，不覆盖当前包、不自动安装或推送。工具链／系统 SDK 会影响二进制字节，未承诺逐字节可复现。重建产物重新打包时必须更新补丁包与 checksum，并重做 GC／完整退出压力、全套 Native 与本地核心流程验收。
