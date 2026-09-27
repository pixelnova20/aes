#!/usr/bin/env bash
# 文件作用：构建 Courseworks 受限执行环境使用的 toolbox Docker 镜像。
# 模块位置：scripts，属于仓库级部署与镜像维护脚本。
# 重要流程：解析仓库根目录和镜像名，调用 docker build，并输出最终镜像标识；本文件不定义独立函数。
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
IMAGE="${DOCKER_TOOLBOX_IMAGE:-courseworks-toolbox:latest}"

BUILD_ARGS=()

add_build_arg() {
  local variable="$1"
  local value="${!variable:-}"
  if [[ -n "$value" ]]; then
    BUILD_ARGS+=(--build-arg "$variable=$value")
  fi
}

add_build_arg NODE_IMAGE
add_build_arg DEBIAN_MIRROR
add_build_arg DEBIAN_SECURITY_MIRROR
add_build_arg LVGL_SOURCE_URL

if [[ -n "${DOCKER_BUILD_NETWORK:-}" ]]; then
  BUILD_ARGS+=(--network "$DOCKER_BUILD_NETWORK")
fi

docker build "${BUILD_ARGS[@]}" --tag "$IMAGE" "$ROOT/docker/toolbox"
printf 'Built %s\n' "$IMAGE"
