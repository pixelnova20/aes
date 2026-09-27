#!/usr/bin/env bash
# 文件作用：检查 Courseworks 依赖、Prisma Client 和前后端构建产物是否安装完整。
# 模块位置：scripts，属于仓库级安装结果验证脚本。
# 重要流程：逐项验证必要文件，并调用 deps:check 检查依赖布局；本文件不定义独立函数。
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

required=(
  "package-lock.json"
  "node_modules/.package-lock.json"
  "node_modules/.prisma/client/index.js"
  "../management/dist/index.js"
  "../management/dist/index.d.ts"
  "apps/server/src/build/app/server.js"
  "apps/web/dist/index.html"
)

for relative_path in "${required[@]}"; do
  if [[ ! -e "$relative_path" ]]; then
    printf 'Missing installation output: %s\n' "$relative_path" >&2
    exit 1
  fi
done

npm run deps:check
printf 'Courseworks build outputs and dependency layout are valid.\n'
