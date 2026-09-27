# 文件作用：定义 Courseworks 编译、测试、QEMU、ctags 和 noVNC 所需的受限 toolbox 镜像。
# 模块位置：docker/toolbox，属于执行基础设施镜像定义。
# 重要阶段：安装交叉编译工具链，创建 runner 用户，安装入口与 QEMU wrapper，并设置非 root 运行环境。
ARG NODE_IMAGE=node:22-bookworm-slim
FROM ${NODE_IMAGE}

ARG DEBIAN_MIRROR=http://deb.debian.org/debian
ARG DEBIAN_SECURITY_MIRROR=http://deb.debian.org/debian-security
ARG LVGL_VERSION=9.5.0
ARG LVGL_SHA256=34a955cdf3a2d005507b704e87357af669a114523b6d3f77b5344fdc68717bc6
ARG LVGL_SOURCE_URL

ENV DEBIAN_FRONTEND=noninteractive
ENV LANG=C.UTF-8 LC_ALL=C.UTF-8

RUN set -eu; \
  case "$DEBIAN_MIRROR" in http://*|https://*) ;; *) echo "Invalid DEBIAN_MIRROR" >&2; exit 1 ;; esac; \
  case "$DEBIAN_SECURITY_MIRROR" in http://*|https://*) ;; *) echo "Invalid DEBIAN_SECURITY_MIRROR" >&2; exit 1 ;; esac; \
  write_sources() { \
    printf "%s\n" \
      "Types: deb" \
      "URIs: $1" \
      "Suites: bookworm bookworm-updates" \
      "Components: main" \
      "Signed-By: /usr/share/keyrings/debian-archive-keyring.gpg" \
      "" \
      "Types: deb" \
      "URIs: $2" \
      "Suites: bookworm-security" \
      "Components: main" \
      "Signed-By: /usr/share/keyrings/debian-archive-keyring.gpg" \
      > /etc/apt/sources.list.d/debian.sources; \
  }; \
  if [ ! -s /etc/ssl/certs/ca-certificates.crt ]; then \
    bootstrap_mirror="$DEBIAN_MIRROR"; \
    bootstrap_security_mirror="$DEBIAN_SECURITY_MIRROR"; \
    case "$bootstrap_mirror" in https://*) bootstrap_mirror="http://${bootstrap_mirror#https://}" ;; esac; \
    case "$bootstrap_security_mirror" in https://*) bootstrap_security_mirror="http://${bootstrap_security_mirror#https://}" ;; esac; \
    write_sources "$bootstrap_mirror" "$bootstrap_security_mirror"; \
    apt-get update; \
    apt-get install -y --no-install-recommends ca-certificates; \
    rm -rf /var/lib/apt/lists/*; \
  fi; \
  write_sources "$DEBIAN_MIRROR" "$DEBIAN_SECURITY_MIRROR"; \
  apt-get update \
  && apt-get install -y --no-install-recommends \
    bash \
    binutils-riscv64-unknown-elf \
    build-essential \
    ca-certificates \
    cmake \
    coreutils \
    cscope \
    curl \
    device-tree-compiler \
    dnsutils \
    file \
    findutils \
    gawk \
    gcc-riscv64-unknown-elf \
    gdb-multiarch \
    git \
    grep \
    iproute2 \
    iputils-ping \
    libcairo2-dev \
    libdrm-dev \
    libegl1-mesa-dev \
    libfreetype-dev \
    libgl1-mesa-dev \
    libgles2-mesa-dev \
    libjpeg-dev \
    libpng-dev \
    libsdl2-dev \
    libsdl2-image-dev \
    libsdl2-mixer-dev \
    libsdl2-ttf-dev \
    libwebp-dev \
    make \
    nano \
    net-tools \
    netcat-openbsd \
    ninja-build \
    novnc \
    openssh-client \
    poppler-utils \
    python3 \
    pkg-config \
    qemu-system-misc \
    ripgrep \
    sed \
    tcpdump \
    tesseract-ocr \
    tesseract-ocr-chi-sim \
    tesseract-ocr-eng \
    universal-ctags \
    exuberant-ctags \
    vim \
    xxd \
    bsdextrautils \
    websockify \
  && curl -fsSL --retry 3 \
    "${LVGL_SOURCE_URL:-https://codeload.github.com/lvgl/lvgl/tar.gz/refs/tags/v${LVGL_VERSION}}" \
    -o /tmp/lvgl.tar.gz \
  && echo "${LVGL_SHA256}  /tmp/lvgl.tar.gz" | sha256sum -c - \
  && tar -xzf /tmp/lvgl.tar.gz -C /opt \
  && mv "/opt/lvgl-${LVGL_VERSION}" /opt/lvgl \
  && chmod -R a+rX /opt/lvgl \
  && ln -s /opt/lvgl /usr/local/include/lvgl \
  && ln -sf /usr/bin/gdb-multiarch /usr/local/bin/riscv64-unknown-elf-gdb \
  && ln -sf /sbin/ifconfig /usr/local/bin/ifconfig \
  && ln -sf /sbin/route /usr/local/bin/route \
  && ln -sf /usr/sbin/arp /usr/local/bin/arp \
  && rm -rf /var/lib/apt/lists/* /root/.npm /tmp/lvgl.tar.gz

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    libncurses-dev \
    ncurses-bin \
    ncurses-term \
  && rm -rf /var/lib/apt/lists/*

RUN usermod --login runner --home /home/runner --move-home node \
  && groupmod --new-name runner node

COPY toolbox-entrypoint.sh /usr/local/bin/toolbox-entrypoint
COPY qemu-system-riscv64-wrapper /usr/local/bin/qemu-system-riscv64
RUN chmod 0755 /usr/local/bin/toolbox-entrypoint /usr/local/bin/qemu-system-riscv64 \
  && /sbin/setcap -r /usr/bin/ping

ENV PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \
    HOME=/home/runner \
    LVGL_ROOT=/opt/lvgl \
    XDG_CONFIG_HOME=/home/runner/.config \
    XDG_DATA_HOME=/home/runner/.local/share \
    XDG_CACHE_HOME=/home/runner/.cache \
    XDG_STATE_HOME=/home/runner/.local/state

WORKDIR /home/runner/project
USER runner

ENTRYPOINT ["toolbox-entrypoint"]
CMD ["make"]
