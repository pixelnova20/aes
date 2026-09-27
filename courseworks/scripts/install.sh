#!/usr/bin/env bash
# 文件作用：在新 Ubuntu 环境中安装依赖、生成 Prisma Client、迁移数据库、构建应用。
# 模块位置：scripts，属于 Courseworks 自动化安装入口。
# 重要函数：run() 统一展示并执行安装命令，同时支持 --dry-run；主流程处理 dry-run 和跳过迁移的命令行选项。
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DRY_RUN=0
SKIP_MIGRATE=0

for argument in "$@"; do
  case "$argument" in
    --dry-run) DRY_RUN=1 ;;
    --skip-migrate) SKIP_MIGRATE=1 ;;
    *)
      printf 'Unknown option: %s\n' "$argument" >&2
      exit 2
      ;;
  esac
done

# 函数功能：打印即将执行的安装命令，并在非 dry-run 模式下执行该命令。
# 输入参数：$@ 表示待执行命令及其全部参数；读取全局 DRY_RUN 决定是否实际执行。
# 输出参数：成功时继承目标命令的标准输出并返回其退出状态；dry-run 时仅输出命令。
# 调用关系：由本脚本安装主流程调用，用于统一执行 npm、mkdir 和验证命令。
run() {
  printf '+'
  printf ' %q' "$@"
  printf '\n'
  if [[ "$DRY_RUN" -eq 0 ]]; then
    "$@"
  fi
}

for command in node npm; do
  command -v "$command" >/dev/null || {
    printf 'Missing required command: %s\n' "$command" >&2
    exit 1
  }
done

cd "$ROOT"
if [[ ! -f .env ]]; then
  printf 'Missing .env. Copy .env.example and configure it before installation.\n' >&2
  exit 1
fi

run npm ci --ignore-scripts
run npm run prisma:generate
run npm run build:management
run npm run deps:check
run npm run check
run npm test
run npm run build
run mkdir -p student-workspace

if [[ "$SKIP_MIGRATE" -eq 0 ]]; then
  run npm run prisma:bootstrap
  run npm run prisma:deploy
fi

run npm run install:verify
if [[ "$DRY_RUN" -eq 1 ]]; then
  printf 'Courseworks installation plan is valid.\n'
else
  printf 'Courseworks installation completed.\n'
fi
