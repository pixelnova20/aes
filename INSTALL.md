# AES 安装与部署

本文说明如何在一台空白的 Ubuntu 22.04 LTS 或 24.04 LTS 服务器上部署 AES。安装分为三部分：

1. 用户安装 Ubuntu 软件包、Node.js 和 Docker；
2. 用户根据所在网络自行配置 Docker，构建并验证 Courseworks toolbox 镜像；
3. 根目录的 `install_script.sh` 完成 AES 的数据库、密钥、应用构建、服务和 Nginx 配置。

默认部署参数如下：

| 项目 | 默认值 |
| --- | --- |
| 安装目录 | `~/aes` |
| systemd 运行账户 | 执行安装的普通用户 |
| 外部 HTTP 端口 | `10001` |
| Courseworks 后端 | `127.0.0.1:3000` |
| MySQL 数据库 | `vibeos_agent` |
| MySQL 用户 | `vibeos_user` |

安装脚本需要通过 `sudo` 获得系统配置权限，但仓库、依赖、构建结果和业务数据仍归发起 `sudo` 的普通用户所有。systemd 业务服务也以该用户身份运行。脚本不会通过 `apt` 安装或升级系统软件，不会访问 Docker Hub 或构建 toolbox 镜像，也不会自动配置 Docker 代理、镜像加速器、域名、TLS 证书或外部防火墙。

## 1. 服务器要求

最低建议配置：

- 64 位 x86 Ubuntu 22.04/24.04；
- 4 个 CPU 核心、8 GB 内存、40 GB 可用磁盘；
- 可访问 npm、Ubuntu 软件源、Docker Hub 和 GitHub；
- 一个可供学生访问的 TCP 端口。

若同时运行多名学生的编译、QEMU 或 noVNC 会话，建议使用 8 个以上 CPU 核心、16 GB 以上内存和 SSD。实际并发能力受 `courseworks/.env` 中的执行预算、QEMU 上限及主机资源共同约束。

## 2. 准备 Ubuntu 环境

安装系统依赖：

```bash
sudo apt update
sudo apt install -y \
  ca-certificates curl git build-essential openssl \
  mysql-server mysql-client nginx docker.io iptables iproute2 \
  python3 python3-venv python3-pip util-linux \
  libreoffice poppler-utils
```

安装 Node.js 22：

```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs
node --version
npm --version
```

`node --version` 必须是 `v22` 或更高版本。然后启动基础服务：

```bash
sudo systemctl enable --now mysql docker nginx
sudo docker version
```

如果这些命令失败，应先解决软件源、Docker 或 MySQL 问题，再运行 AES 安装脚本。

## 3. 克隆仓库并准备 Docker 镜像

将仓库克隆到默认目录：

```bash
git clone https://github.com/pixelnova20/aes.git "$HOME/aes"
cd "$HOME/aes"
```

确认服务器上没有需要保留的同名目录。**不要使用 `sudo git clone`，也不要使用 `sudo git pull`**；仓库必须始终由当前普通用户拥有。

Courseworks 使用 `courseworks-toolbox:latest` 作为学生编译、Coding Agent、QEMU 和 noVNC 的隔离执行环境。镜像构建包含三类下载：Docker 基础镜像、容器内 Debian 软件包和 LVGL 源码。AES 不修改 Docker daemon 的代理或镜像加速配置，但构建脚本允许分别覆盖这三类来源。

先验证 Docker daemon，并单独拉取基础镜像：

```bash
sudo docker version
sudo docker pull node:22-bookworm-slim
```

如果这一步超时，需要先由安装者配置 Docker daemon 的代理或可信镜像加速器。容器内的 Debian 软件包源不会影响基础镜像拉取。

基础镜像可正常拉取后，选择下面一种方式构建 toolbox。网络可直接访问 Debian 官方源时执行：

```bash
cd "$HOME/aes"
sudo env DOCKER_TOOLBOX_IMAGE=courseworks-toolbox:latest \
  bash courseworks/scripts/build-images.sh
```

在中国大陆网络中，可通过构建参数使用国内 Debian 镜像。例如使用[中国科学技术大学 Debian 镜像](https://mirrors.ustc.edu.cn/help/debian.html)：

```bash
cd "$HOME/aes"
sudo env \
  DEBIAN_MIRROR=https://mirrors.ustc.edu.cn/debian \
  DEBIAN_SECURITY_MIRROR=https://mirrors.ustc.edu.cn/debian-security \
  DOCKER_TOOLBOX_IMAGE=courseworks-toolbox:latest \
  bash courseworks/scripts/build-images.sh
```

如果基础镜像尚未包含系统 CA 证书，Dockerfile 会先通过同一镜像的 HTTP 地址安装 `ca-certificates`，随后切回上述 HTTPS 地址继续安装。Debian APT 会在这个引导阶段继续校验仓库签名和软件包哈希。

这两个变量只替换容器内的 Debian 软件包源。若单位提供自己的基础镜像仓库或 LVGL 归档镜像，还可分别设置 `NODE_IMAGE` 和 `LVGL_SOURCE_URL`；LVGL 下载后仍会执行仓库中固定的 SHA-256 校验。例如：

```bash
sudo env \
  NODE_IMAGE=registry.example.edu/library/node:22-bookworm-slim \
  LVGL_SOURCE_URL=https://mirror.example.edu/lvgl/v9.5.0.tar.gz \
  DEBIAN_MIRROR=https://mirrors.ustc.edu.cn/debian \
  DEBIAN_SECURITY_MIRROR=https://mirrors.ustc.edu.cn/debian-security \
  bash courseworks/scripts/build-images.sh
```

不要使用来源不明的镜像或源码代理。也可以将上述地址替换为单位内部维护的可信镜像。

执行仓库提供的完整镜像验证。该检查会启动临时容器，验证编译器、QEMU、noVNC、网络工具、OCR、PDF 工具和图形开发库：

```bash
cd "$HOME/aes"
sudo env DOCKER_TOOLBOX_IMAGE=courseworks-toolbox:latest \
  bash courseworks/scripts/verify-images.sh
```

最后确认镜像存在：

```bash
sudo docker image inspect courseworks-toolbox:latest \
  --format '{{.Id}} {{.RepoTags}}'
```

只有上述构建和验证全部成功后，才继续执行主安装脚本。

## 4. 安装 AES

首次安装执行：

```bash
cd "$HOME/aes"
sudo ./install_script.sh
```

主安装脚本只验证预先构建的 toolbox 镜像，不会拉取基础镜像或重新构建它。

仓库中的 `superuser.toml` 包含示例凭据。首次运行时，脚本检测到示例值后会询问：

- 超级用户邮箱；
- 超级用户密码；
- 再次输入密码进行确认。

密码输入不会显示在终端中。脚本随后会自动完成：

1. 将执行安装的普通用户加入 Docker 组，并保持仓库归该用户所有；
2. 验证预先构建的 Courseworks toolbox 镜像；
3. 限制 `superuser.toml` 和 `courseworks/.env` 的文件权限；
4. 自动生成 MySQL 密码、JWT 密钥和两个 Flask 会话密钥；
5. 创建 `vibeos_agent` 数据库及 `vibeos_user`；
6. 创建持久化数据目录和 Python 虚拟环境；
7. 安装 Python、Node.js 依赖并运行代码检查和测试；
8. 执行 Prisma migration 并构建前后端；
9. 初始化模型目录和超级用户；
10. 建立受限 Docker 网络及相应 iptables 规则；
11. 安装并启动 Courseworks、Homeworks、Slideshow systemd 服务；
12. 将前端静态文件发布到 `/var/lib/aes/www`，安装 Nginx 统一入口并检查三个 HTTP 入口。

脚本遇到错误会立即停止；修复错误后可以再次执行同一命令。已有的 `courseworks/.env` 和非示例 `superuser.toml` 不会被重新生成。脚本会将当前普通用户加入 `docker` 组；安装脚本可立即使用 Docker，用户若要在当前终端直接执行 `docker`，通常需要注销并重新登录。

服务启动后，安装器会为每个 HTTP 入口等待最多 60 秒。入口持续不可用时，安装器会打印对应 systemd 服务状态和最近日志后停止。

### 使用其他端口

默认端口是 `10001`。首次安装时可以指定其他端口：

```bash
sudo ./install_script.sh --port 18080
```

也可以通过环境变量指定端口：

```bash
sudo AES_HTTP_PORT=18080 ./install_script.sh
```

后续重复执行脚本时，如果没有再次指定端口，脚本会沿用现有 Nginx AES 配置中的端口。

查看参数说明：

```bash
./install_script.sh --help
```

### 非交互安装

在自动化环境中，应先编辑 `superuser.toml`，再运行脚本。部署后应使用 `chmod 600 superuser.toml` 限制读取权限。配置格式如下：

```toml
# AES 超级用户登录凭据。部署前必须修改；不要提交真实邮箱和密码。
[superuser]
email = "admin@example.edu"
password = "change-me"

[limits.workspace]
disk_mb = 250
max_terminals = 5
idle_minutes = 30

[limits.execution]
max_cpu_cores = 1.0
max_memory_mb = 1024
max_processes = 192
max_concurrent_qemu = 2

[limits.ai]
max_concurrent_requests_per_user = 1
```

超级用户密码与教师、学生密码采用相同规则：至少 6 个字符，不要求混合大小写字母、数字或特殊符号。不要把修改后的真实凭据提交到公开仓库。该文件是超级用户凭据和全局资源上限的权威来源；后端启动时会把密码的 bcrypt 哈希同步到数据库。

资源设置只保留部署时必须决定的三组上限：

| 配置段 | 配置项 | 作用 |
| --- | --- | --- |
| `limits.workspace` | `disk_mb` | 每个用户在每门课程中的持久化工作区容量 |
| `limits.workspace` | `max_terminals` | 每个工作区最多同时打开的终端数 |
| `limits.workspace` | `idle_minutes` | 终端无活动后自动回收的时间，不会删除工作区文件 |
| `limits.execution` | `max_cpu_cores` | 单个构建、Agent、终端或 QEMU 容器可使用的 CPU 上限 |
| `limits.execution` | `max_memory_mb` | 单个执行容器可使用的内存上限 |
| `limits.execution` | `max_processes` | 单个执行容器的进程数上限，用于防止进程失控 |
| `limits.execution` | `max_concurrent_qemu` | 整个 AES 实例可同时运行的 QEMU 数量 |
| `limits.ai` | `max_concurrent_requests_per_user` | 同一用户跨 Slideshow、Homeworks 和 Courseworks 的 AI 请求并发数 |

容器类型仍保留各自较低的内部默认值；这里配置的是统一安全上限，不会把轻量容器强行提升到该资源量。旧版本中不含这些分段的 `superuser.toml` 仍可启动，并会采用示例中的默认限制。

## 5. 安装结果与配置

安装完成后，脚本会打印访问地址。默认地址为：

```text
http://SERVER_IP:10001/
```

使用安装时设置的超级用户邮箱和密码登录。

![AES 登录页](docs/pictures/login.png)

主要配置和数据位置：

| 路径 | 内容 |
| --- | --- |
| `~/aes/superuser.toml` | 超级用户邮箱、明文密码和全局资源上限 |
| `~/aes/courseworks/.env` | 数据库、会话密钥、资源和网络配置 |
| `~/aes/accounts-data/` | Homeworks、Slideshow 的 SQLite 数据 |
| `~/aes/homeworks/uploads/` | 题库和学生附件 |
| `~/aes/slideshow/uploads/` | 原始 PPT 和转换结果 |
| `~/aes/courseworks/student-workspace/` | Courseworks 持久化工作区 |
| `~/aes/archive-data/` | 删除操作产生的归档 |
| `/var/lib/aes/home/` | 服务运行时使用的独立 HOME 和缓存目录 |
| `/var/lib/aes/www/` | 供 Nginx 读取的前端静态文件副本 |

脚本从默认路由自动识别 `DOCKER_DIRECT_IFACE`。若服务器有多张网卡、VPN 或策略路由，请检查：

```bash
grep '^DOCKER_DIRECT_IFACE=' "$HOME/aes/courseworks/.env"
ip route show default
```

修改 `courseworks/.env` 后通常需要重启相关服务：

```bash
sudo systemctl restart courseworks-network
sudo systemctl restart courseworks-backend homework slideshow
```

修改 `superuser.toml` 后必须重启 `courseworks-backend` 和 `homework`。如果修改的是超级用户凭据，旧超级用户会被禁用，已有旧超级用户会话也会失效；如果只修改资源限制，新限制会在 Courseworks 后端重启后生效。

如果启用了 UFW，开放实际使用的端口：

```bash
sudo ufw allow 10001/tcp
```

## 6. 安装后验证

检查服务：

```bash
sudo systemctl is-active mysql docker nginx \
  courseworks-network courseworks-backend homework slideshow
sudo ss -lntp | grep -E ':3000|:10001'
curl -I http://127.0.0.1:10001/
curl -I http://127.0.0.1:10001/homeworks/
curl -I http://127.0.0.1:10001/slideshow/
```

至少使用超级用户、教师和学生测试账户完成以下浏览器验收：

1. 超级用户可以登录并创建教师邀请码；
2. 教师可以注册、创建班级并取得班级邀请码；
3. 学生可以注册、加入和切换班级；
4. 三个子系统只显示当前工作班级的数据；
5. Slideshow 可以上传、转换并打开 PPT；
6. Homeworks 可以创建、发布、提交、批改并查看批注；
7. Courseworks 可以创建文件、保存并重新打开；
8. AI Provider 测试和对话正常；
9. OS Lab 的 Bash、QEMU 和 noVNC 均能连接；
10. 服务器重启后服务自动启动，数据和工作区仍然存在。

看到登录页只说明 Nginx 和前端入口可访问，不能代替完整验收。

## 7. 配置 HTTPS

AES 默认提供 HTTP。生产环境应在 Nginx、负载均衡器或 NAS 反向代理上终止 TLS，再代理到 AES HTTP 端口。反向代理必须支持 WebSocket，并为以下接口保留较长超时：

- `/api/workspace/lab/terminal`
- `/api/workspace/lab/vnc`

不要在没有 TLS 终止配置的情况下直接把 `https://` 指向 HTTP 端口。启用 HTTPS 后，应确认代理传递 `Host`、`X-Forwarded-For` 和 `X-Forwarded-Proto`。

## 8. 恢复已有 AES 数据

`install_script.sh` 默认按新系统初始化。迁移或复制已有 AES 时，先运行脚本完成程序和服务安装，再停止业务服务：

```bash
sudo systemctl stop courseworks-backend homework slideshow
```

从**同一个备份时间点**恢复：

- MySQL 的 `vibeos_agent` 数据库；
- `accounts-data/`；
- `homeworks/uploads/`；
- `slideshow/uploads/`；
- `courseworks/student-workspace/`；
- `archive-data/`；
- 原环境中仍适用于目标机的 `courseworks/.env` 配置；
- 原环境的 `superuser.toml`。

修复文件权限并应用当前版本 migration：

```bash
sudo chown -R "$USER:$(id -gn)" \
  "$HOME/aes/accounts-data" \
  "$HOME/aes/homeworks/uploads" \
  "$HOME/aes/slideshow/uploads" \
  "$HOME/aes/courseworks/student-workspace" \
  "$HOME/aes/archive-data"
sudo chown "$USER:$(id -gn)" \
  "$HOME/aes/courseworks/.env" \
  "$HOME/aes/superuser.toml"
chmod 600 "$HOME/aes/courseworks/.env" "$HOME/aes/superuser.toml"

cd "$HOME/aes"
sudo ./install_script.sh
```

如果目标机路径、数据库密码或网卡名不同，必须先调整恢复后的 `.env`。不要只复制 SQLite 或只导入 MySQL，否则统一账户、班级、作业和课件会不一致。

## 9. 日常维护

查看日志：

```bash
sudo journalctl -u courseworks-backend -f
sudo journalctl -u homework -f
sudo journalctl -u slideshow -f
sudo tail -f /var/log/nginx/error.log
```

代码升级前先备份数据库、上传文件和工作区，并安排维护窗口。然后执行：

```bash
cd "$HOME/aes"
git pull --ff-only
sudo ./install_script.sh
```

安装脚本会保留已有 `.env`、`superuser.toml` 和业务数据，重新安装依赖、执行测试和 migration、构建应用，并刷新 systemd/Nginx 配置。它不会重新构建 Docker 镜像。若升级包含 `courseworks/docker/toolbox/` 的改动，应先重新执行第 3 节的镜像构建与验证，再运行安装脚本。涉及数据库模型、toolbox、QEMU 或 noVNC 的升级不应跳过相应步骤。

## 10. 卸载 AES

在仓库根目录执行：

```bash
cd "$HOME/aes"
sudo ./uninstall_script.sh
```

不带参数运行时，脚本会显示交互式菜单：

1. 删除服务、用户数据、数据库和 Docker 镜像；
2. 只删除服务和运行部署，保留用户数据、数据库、配置和 Docker 镜像；
3. 删除服务、用户数据和数据库，但保留 Docker 镜像；
4. 退出，不执行任何操作。

所有方式都会保留源码目录和 Ubuntu 共享软件包。菜单中的第 2 项与旧版默认行为一致：它会停止并删除 AES systemd 服务、Nginx 配置、AES 管理的临时容器、受限 Docker 网络、防火墙规则以及 `/var/lib/aes` 中的运行文件，同时保留数据库、上传文件、SQLite 数据、归档、学生工作区、`courseworks/.env` 和 toolbox 镜像。

永久删除 AES 业务数据时必须显式确认：

```bash
sudo ./uninstall_script.sh --purge-data
```

同时删除 toolbox 镜像：

```bash
sudo ./uninstall_script.sh --purge-data --remove-image
```

自动化环境可增加 `--yes`，执行前可以使用 `--dry-run` 查看操作：

```bash
./uninstall_script.sh --purge-data --remove-image --yes --dry-run
sudo ./uninstall_script.sh --purge-data --remove-image --yes
```

卸载脚本不会删除仓库本身。确认不再需要其中的 `superuser.toml` 和其他本地配置后，可由当前普通用户自行删除 `$HOME/aes`。

## 11. 常见问题

### 安装脚本提示缺少 toolbox 镜像

主安装脚本不会访问 Docker Hub 或构建镜像。返回第 3 节，确保下面两项都成功后再重新运行安装脚本：

```bash
sudo docker image inspect courseworks-toolbox:latest
sudo env DOCKER_TOOLBOX_IMAGE=courseworks-toolbox:latest \
  bash courseworks/scripts/verify-images.sh
```

如果 `docker pull` 或 `docker build` 超时，应由服务器管理员配置 Docker daemon 的代理、DNS 或可信镜像加速器。

### 安装脚本提示缺少命令

重新执行“准备 Ubuntu 环境”中的 apt 和 Node.js 安装命令。脚本不会自动修改系统软件源或安装 apt 软件包。

### Git 提示 dubious ownership

这通常表示仓库曾通过 `sudo git clone` 创建，或安装脚本把整个仓库改成了其他用户所有。不要通过添加 `safe.directory` 掩盖所有权问题，也不要继续使用 `sudo git pull`。推荐保留旧目录供核对，在普通用户 HOME 下重新克隆：

```bash
cd "$HOME"
git clone https://github.com/pixelnova20/aes.git aes
cd "$HOME/aes"
sudo ./install_script.sh
```

新安装脚本会在修改系统前检查仓库所有者，并且不会再递归修改仓库所有权。

### 服务启动失败

```bash
sudo systemctl status --no-pager \
  courseworks-network courseworks-backend homework slideshow
sudo journalctl -u courseworks-backend -n 200 --no-pager
```

脚本可以重复执行，但不应通过删除 `.env` 或数据库来绕过启动错误。

### 准备提交公开仓库

提交或推送前运行：

```bash
./scripts/check_open_source_readiness.sh
```

该检查会验证 `superuser.toml` 是否仍为公开示例值、其他本地凭据和运行数据的忽略规则、已跟踪文件清单、敏感信息特征，以及文档是否只分布在仓库根目录和 `docs/`。

### 页面可打开，但终端或 noVNC 连接失败

检查 Docker、运行账户的用户组、Nginx WebSocket 配置和受限网络服务：

```bash
id "$USER"
sudo docker ps
sudo systemctl status courseworks-network --no-pager
sudo nginx -T | grep -n 'workspace/lab'
```

### PPT 上传后转换失败

```bash
command -v libreoffice pdftoppm
sudo journalctl -u slideshow -n 200 --no-pager
test -w "$HOME/aes/slideshow/uploads"
```

### AI 请求超时

在服务门户测试当前 Provider，确认 Base URL、模型名和 API Key 正确，并确认服务器能访问 Provider。班级指派 Profile 是教师 Profile 的引用；教师修改后学生无需复制配置，但需要刷新页面或重新发起请求以读取最新值。

### 数据目录权限错误

```bash
sudo chown -R "$USER:$(id -gn)" \
  "$HOME/aes/accounts-data" \
  "$HOME/aes/homeworks/uploads" \
  "$HOME/aes/slideshow/uploads" \
  "$HOME/aes/courseworks/student-workspace" \
  "$HOME/aes/archive-data"
```
