#!/bin/sh
# 文件作用：初始化 toolbox 容器中的 XDG 运行目录，并启动调用方指定的命令。
# 模块位置：docker/toolbox，属于沙箱容器启动适配层。
# 重要流程：创建 runner 用户运行目录后通过 exec 交接进程；本文件不定义独立函数。
set -eu

# 每次执行都使用临时运行 home；这里创建命令行工具需要的通用 XDG 目录。
mkdir -p \
  "$XDG_CONFIG_HOME" \
  "$XDG_DATA_HOME" \
  "$XDG_CACHE_HOME" \
  "$XDG_STATE_HOME"

exec "$@"
