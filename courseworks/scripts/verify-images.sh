#!/usr/bin/env bash
# 文件作用：验证 toolbox 镜像及其编译器、QEMU、noVNC 和 Node 工具是否完整。
# 模块位置：scripts，属于仓库级安装验证脚本。
# 重要流程：检查镜像存在性，在临时容器中逐项探测必要命令；本文件不定义独立函数。
set -euo pipefail

IMAGE="${DOCKER_TOOLBOX_IMAGE:-courseworks-toolbox:latest}"

docker image inspect "$IMAGE" >/dev/null
docker run --rm "$IMAGE" sh -lc '
  set -eu
  command -v make
  command -v riscv64-unknown-elf-gcc
  command -v qemu-system-riscv64
  command -v websockify
  command -v ifconfig
  command -v route
  command -v arp
  command -v ip
  command -v ss
  command -v ping
  command -v dig
  command -v nslookup
  command -v nc
  command -v tcpdump
  command -v tesseract
  tesseract --list-langs | grep -qx chi_sim
  tesseract --list-langs | grep -qx eng
  command -v pdfinfo
  command -v pdftotext
  command -v pdftoppm
  command -v pdftocairo
  command -v pdfimages
  command -v sdl2-config
  pkg-config --exists sdl2 SDL2_image SDL2_ttf SDL2_mixer
  pkg-config --exists cairo freetype2 libpng libjpeg libwebp
  pkg-config --exists libdrm egl glesv2 gl
  pkg-config --exists ncursesw
  printf "%s\n" \
    "#include <SDL2/SDL.h>" \
    "int main(void) { return SDL_Init(0); }" \
    | cc -x c - $(sdl2-config --cflags --libs) -o /tmp/sdl-verify
  /tmp/sdl-verify
  printf "%s\n" \
    "#include <ncursesw/curses.h>" \
    "int main(void) { return curses_version() == 0; }" \
    | cc -x c - $(pkg-config --cflags --libs ncursesw) -o /tmp/ncurses-verify
  /tmp/ncurses-verify
  test "$LVGL_ROOT" = /opt/lvgl
  test -f "$LVGL_ROOT/lvgl.h"
  test -f "$LVGL_ROOT/lv_conf_template.h"
  grep -q "LVGL_VERSION_MAJOR 9" "$LVGL_ROOT/lv_version.h"
  cc -std=c11 -DLV_CONF_SKIP -I"$LVGL_ROOT" -I"$LVGL_ROOT/src" \
    -c "$LVGL_ROOT/src/core/lv_obj.c" -o /tmp/lv_obj.o
  test -z "$(/sbin/getcap /usr/bin/ping)"
  node --version
'

docker run --rm \
  --network none \
  --sysctl 'net.ipv4.ping_group_range=0 2147483647' \
  --security-opt no-new-privileges \
  --cap-drop ALL \
  "$IMAGE" ping -c 1 -W 2 127.0.0.1 >/dev/null

docker run --rm "$IMAGE" sh -lc '
  set -eu
  socket=/tmp/courseworks-qmp-verify.sock
  cleanup() {
    if [ -n "${qemu_pid:-}" ]; then
      kill "$qemu_pid" 2>/dev/null || true
      wait "$qemu_pid" 2>/dev/null || true
    fi
  }
  trap cleanup EXIT
  COURSEWORKS_QMP_SOCKET="$socket" qemu-system-riscv64 \
    -machine virt -nodefaults -device virtio-gpu-device -S >/tmp/qemu-verify.log 2>&1 &
  qemu_pid=$!
  attempts=50
  while [ ! -S "$socket" ] && [ "$attempts" -gt 0 ]; do
    sleep 0.1
    attempts=$((attempts - 1))
  done
  test -S "$socket"
'
printf 'Verified %s\n' "$IMAGE"
