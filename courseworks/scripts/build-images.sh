#!/usr/bin/env bash
# 文件作用：构建 Courseworks 受限执行环境使用的 toolbox Docker 镜像。
# 模块位置：scripts，属于仓库级部署与镜像维护脚本。
# 重要流程：解析仓库根目录和镜像名，调用 docker build，并输出最终镜像标识；本文件不定义独立函数。
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
IMAGE="${DOCKER_TOOLBOX_IMAGE:-courseworks-toolbox:latest}"

docker build --tag "$IMAGE" "$ROOT/docker/toolbox"
printf 'Built %s\n' "$IMAGE"
