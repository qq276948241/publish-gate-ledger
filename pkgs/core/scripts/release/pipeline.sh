#!/usr/bin/env bash

# 发布链统一入口（在 pkgs/core 下执行）
#
#   ./scripts/release/pipeline.sh gates       只跑五道门禁核对
#   ./scripts/release/pipeline.sh dry-run     全流程演练（含 npm pack，不推送）
#   ./scripts/release/pipeline.sh publish     真正发布（需 npm 凭据）
#   ./scripts/release/pipeline.sh bump <kind> 一把升版本 + CHANGELOG

set -euo pipefail

cd "$(dirname "$0")/../.."

case "${1:-gates}" in
  gates)
    for gate in 1-split 1b-deps 2-treeshake 3-types 4-preflight; do
      node "scripts/release/gate/${gate}.ts"
    done
    ;;
  dry-run)
    node scripts/release/gate/5-publish.ts
    ;;
  publish)
    node scripts/release/gate/5-publish.ts --publish
    ;;
  bump)
    node scripts/release/gate/bump.ts "${2:?用法: bump <major|minor|patch|x.y.z>}"
    ;;
  *)
    echo "未知命令: $1（可用: gates | dry-run | publish | bump）" >&2
    exit 1
    ;;
esac
