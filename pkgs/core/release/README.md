# 发布链（Publish Gates）

下游业务仓库直接安装的拆分发布链，四道功能、五道门禁，任一环节对不上即停止发布。

## 拆分配置

`release/split.config.json` 声明功能包 → 主包模块的归属：

- 每个主包模块必须且只能归属一个功能包（防止复制/重叠）
- 功能包是零复制门面，只 `export * from "date-fns/<module>"`
- 功能包之间禁止互相依赖，跨功能调用统一走主包

改拆分方式后必须从 Gate 1 重跑全链；`dist/split/manifest.json` 里的
`configHash` 随配置变化，审计记录会保留本次核对时的哈希。

## 门禁

| Gate | 脚本 | 职责 |
| --- | --- | --- |
| 1 | `scripts/release/gate/1-split.ts` | 校验配置、模块唯一归属，生成功能包与 manifest |
| 1b | `scripts/release/gate/1b-deps.ts` | 包数、依赖、循环依赖、空壳门面、主入口聚合核对 |
| 2 | `scripts/release/gate/2-treeshake.ts` | `sideEffects`、未用模块摇净、摇后/基线运行一致、无空壳 |
| 3 | `scripts/release/gate/3-types.ts` | 声明随包、版本全链一致、声明导出与 JS 产物逐一相符 |
| 4 | `scripts/release/gate/4-preflight.ts` | 发布前总包数/声明/版本总核对，写 preflight 审计 |
| 5 | `scripts/release/gate/5-publish.ts` | 强制重跑 1-4，`npm pack`（dry-run）或 `npm publish`，写发布审计 |

## 使用

```bash
./scripts/release/pipeline.sh bump patch      # 4.4.0 -> 4.4.1，CHANGELOG 同步出段
./scripts/release/pipeline.sh gates           # 只核对，不发布
./scripts/release/pipeline.sh dry-run         # 全流程演练（npm pack，产物落 release/audit/）
./scripts/release/pipeline.sh publish         # 真正发布（需 npm 凭据）
```

## 审计回查

每次核对/发布都在 `release/audit/` 留痕：

- `<version>-preflight.json`：发布前逐项核对结果（核了哪些、过了哪些）
- `<version>-publish.json`：门禁结果、发布状态、每个包产物、当次 manifest

前置条件：主包已构建（`mise run build/package` 或现有 `scripts/build/package.sh`），
功能包产物在 Gate 1 生成到 `dist/split/`。
