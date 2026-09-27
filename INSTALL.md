# AES 安装与部署

本文说明如何在一台空白的 Ubuntu 22.04 LTS 或 24.04 LTS 服务器上部署 AES。安装分为两部分：

1. 用户安装 Ubuntu 软件包和 Node.js；
2. 根目录的 `install_script.sh` 完成 AES 的数据库、密钥、构建、服务和 Nginx 配置。

默认部署参数如下：

| 项目 | 默认值 |
| --- | --- |
| 安装目录 | `/opt/aes` |
| systemd 运行账户 | `aes` |
| 外部 HTTP 端口 | `10001` |
| Courseworks 后端 | `127.0.0.1:3000` |
| MySQL 数据库 | `vibeos_agent` |
| MySQL 用户 | `vibeos_user` |

安装脚本需要 root 权限。它不会通过 `apt` 安装或升级系统软件，也不会自动配置域名、TLS 证书或外部防火墙。

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

## 3. 克隆并安装 AES

将仓库克隆到默认目录：

```bash
sudo git clone https://github.com/pixelnova20/aes.git /opt/aes
cd /opt/aes
```

确认服务器上没有需要保留的同名目录。首次安装只需执行：

```bash
sudo ./install_script.sh
```

仓库中的 `superuser.toml` 包含示例凭据。首次运行时，脚本检测到示例值后会询问：

- 超级用户邮箱；
- 超级用户密码；
- 再次输入密码进行确认。

密码输入不会显示在终端中。脚本随后会自动完成：

1. 创建 `aes` 系统账户并授予 Docker 使用权限；
2. 限制 `superuser.toml` 和 `courseworks/.env` 的文件权限；
3. 自动生成 MySQL 密码、JWT 密钥和两个 Flask 会话密钥；
4. 创建 `vibeos_agent` 数据库及 `vibeos_user`；
5. 创建持久化数据目录和 Python 虚拟环境；
6. 安装 Python、Node.js 依赖并运行代码检查和测试；
7. 执行 Prisma migration，构建前后端和 Courseworks toolbox 镜像；
8. 初始化模型目录和超级用户；
9. 建立受限 Docker 网络及相应 iptables 规则；
10. 安装并启动 Courseworks、Homeworks、Slideshow systemd 服务；
11. 安装 Nginx 统一入口并检查三个 HTTP 入口。

首次构建 toolbox 镜像需要下载较多软件包，运行时间可能较长。脚本遇到错误会立即停止；修复错误后可以再次执行同一命令。已有的 `courseworks/.env` 和非示例 `superuser.toml` 不会被重新生成。

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

## 4. 安装结果与配置

安装完成后，脚本会打印访问地址。默认地址为：

```text
http://SERVER_IP:10001/
```

使用安装时设置的超级用户邮箱和密码登录。

![AES 登录页](docs/pictures/login.png)

主要配置和数据位置：

| 路径 | 内容 |
| --- | --- |
| `/opt/aes/superuser.toml` | 超级用户邮箱、明文密码和全局资源上限 |
| `/opt/aes/courseworks/.env` | 数据库、会话密钥、资源和网络配置 |
| `/opt/aes/accounts-data/` | Homeworks、Slideshow 的 SQLite 数据 |
| `/opt/aes/homeworks/uploads/` | 题库和学生附件 |
| `/opt/aes/slideshow/uploads/` | 原始 PPT 和转换结果 |
| `/opt/aes/courseworks/student-workspace/` | Courseworks 持久化工作区 |
| `/opt/aes/archive-data/` | 删除操作产生的归档 |

脚本从默认路由自动识别 `DOCKER_DIRECT_IFACE`。若服务器有多张网卡、VPN 或策略路由，请检查：

```bash
grep '^DOCKER_DIRECT_IFACE=' /opt/aes/courseworks/.env
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

## 5. 安装后验证

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

## 6. 配置 HTTPS

AES 默认提供 HTTP。生产环境应在 Nginx、负载均衡器或 NAS 反向代理上终止 TLS，再代理到 AES HTTP 端口。反向代理必须支持 WebSocket，并为以下接口保留较长超时：

- `/api/workspace/lab/terminal`
- `/api/workspace/lab/vnc`

不要在没有 TLS 终止配置的情况下直接把 `https://` 指向 HTTP 端口。启用 HTTPS 后，应确认代理传递 `Host`、`X-Forwarded-For` 和 `X-Forwarded-Proto`。

## 7. 恢复已有 AES 数据

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
sudo chown -R aes:aes \
  /opt/aes/accounts-data \
  /opt/aes/homeworks/uploads \
  /opt/aes/slideshow/uploads \
  /opt/aes/courseworks/student-workspace \
  /opt/aes/archive-data
sudo chmod 600 /opt/aes/courseworks/.env /opt/aes/superuser.toml

cd /opt/aes/courseworks
sudo -u aes -H env PATH="/opt/aes/.venv/bin:$PATH" npm run prisma:generate
sudo -u aes -H env PATH="/opt/aes/.venv/bin:$PATH" npm run prisma:deploy
sudo -u aes -H env PATH="/opt/aes/.venv/bin:$PATH" npm run build
sudo systemctl start courseworks-backend homework slideshow
```

如果目标机路径、数据库密码或网卡名不同，必须先调整恢复后的 `.env`。不要只复制 SQLite 或只导入 MySQL，否则统一账户、班级、作业和课件会不一致。

## 8. 日常维护

查看日志：

```bash
sudo journalctl -u courseworks-backend -f
sudo journalctl -u homework -f
sudo journalctl -u slideshow -f
sudo tail -f /var/log/nginx/error.log
```

代码升级前先备份数据库、上传文件和工作区，并安排维护窗口。然后执行：

```bash
cd /opt/aes
sudo -u aes git pull --ff-only
sudo ./install_script.sh
```

安装脚本会保留已有 `.env`、`superuser.toml` 和业务数据，重新安装依赖、执行测试和 migration、构建镜像与应用，并刷新 systemd/Nginx 配置。涉及数据库模型、toolbox、QEMU 或 noVNC 的升级不应跳过完整脚本。

## 9. 常见问题

### 安装脚本提示缺少命令

重新执行“准备 Ubuntu 环境”中的 apt 和 Node.js 安装命令。脚本不会自动修改系统软件源或安装 apt 软件包。

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
id aes
sudo -u aes docker ps
sudo systemctl status courseworks-network --no-pager
sudo nginx -T | grep -n 'workspace/lab'
```

### PPT 上传后转换失败

```bash
command -v libreoffice pdftoppm
sudo journalctl -u slideshow -n 200 --no-pager
sudo -u aes test -w /opt/aes/slideshow/uploads
```

### AI 请求超时

在服务门户测试当前 Provider，确认 Base URL、模型名和 API Key 正确，并确认服务器能访问 Provider。班级指派 Profile 是教师 Profile 的引用；教师修改后学生无需复制配置，但需要刷新页面或重新发起请求以读取最新值。

### 数据目录权限错误

```bash
sudo chown -R aes:aes \
  /opt/aes/accounts-data \
  /opt/aes/homeworks/uploads \
  /opt/aes/slideshow/uploads \
  /opt/aes/courseworks/student-workspace \
  /opt/aes/archive-data
```
