# 数据与运行日志

AES 的应用数据统一位于根目录 `production-data/`，日志统一位于根目录 `logs/`。这两个目录整体被 Git 忽略，安装时自动创建，不随源码发布。MySQL 原始数据文件由系统管理，保留在系统路径（Ubuntu 默认 `/var/lib/mysql/`），不放入项目目录。

```text
production-data/
  accounts/accounts.db           共享账户、身份及邀请码
  homeworks/courses.db           课程、题库、提交、批改和成绩
  homeworks/uploads/             题目附件、学生上传文件
  slideshow/slideshow.db         课件元数据
  slideshow/uploads/             原始课件、转换图片和提取内容
  courseworks/workspaces/        学生文件、会话及实验持久状态
  archives/                     删除账户等操作的恢复归档
  backups/                      迁移前的应用文件及 MySQL 逻辑备份
logs/
  auth/                         登录成功、失败、单点登录和退出
  operations/                   三个子系统的操作与请求结果
  resources/                    主机、服务、容器、准入及回收指标
  runtime/                      三个服务的标准输出和错误
  courseworks/                  可选调试日志（仅在主动启用时产生）
  legacy-courseworks/            迁移前的历史日志（如有）
```

`AES_ROOT`、`AES_DATA_ROOT`、`AES_LOG_ROOT` 在 `courseworks/.env` 配置；安装脚本填写绝对路径。`superuser.toml` 和 `.env` 是部署配置，备份时仍须单独妥善保存。不要把含真实凭据的 `superuser.toml` 提交到公开仓库。

## 已有安装迁移

先更新并构建源码，在维护窗口执行：

```bash
sudo python3 scripts/configure-runtime.py --root "$PWD" --user "$USER"
```

脚本停止三个业务服务，备份应用文件并通过 mysqldump 生成 `mysql.sql`，再迁移数据并更新服务配置；MySQL 保持运行，原始数据文件不移动。上传目录及学生工作区可保留旧路径的兼容软链接，以保证既有绝对路径仍可解析；实际文件只有一份，位于 `production-data/`。不要手工删除软链接的目标目录。

`production-data/` 中的应用数据和备份归安装时指定的 AES 服务账户所有（XPS15 为 `zhiyuan`），该账户能够读取、写入并进入相应目录。根目录和新备份目录权限为 700，备份文件为 600；迁移的应用文件保留原有访问位并补齐所有者权限。脚本不跟随工作区中的符号链接修改外部文件权限。MySQL 系统目录仍归 `mysql` 所有，通过数据库连接或逻辑备份访问，不向普通用户开放原始数据文件。

曾使用旧版 `production-data/courseworks/mysql/` 绑定挂载的安装，需要先停止三个 AES 服务，再执行 `sudo python3 scripts/release-mysql-storage.py "$PWD"` 恢复系统路径，然后执行上面的迁移配置命令并启动业务服务。该恢复脚本不删除数据库内容。

安装脚本会调用此迁移配置步骤。迁移失败时自动还原已搬动的目录与服务配置；备份位置会在控制台显示。不要在运行中的 MySQL 上直接打包数据文件：先停服再备份整个目录，或者使用逻辑备份并同步保存 SQLite、上传文件和学生工作区。

卸载时，保留数据模式保留应用数据与数据库；清除数据模式删除 AES 数据库及应用数据、日志。Ubuntu 的 MySQL 软件包及系统数据库不会被一并删除。只备份 `production-data/` 不包含 MySQL 的实时内容，还须生成当前数据库的逻辑备份；历史迁移备份不会自动更新。

## 日志格式与范围

公共实现位于 `management/src/event-log.ts` 与 `management/aes_logging.py`。每条 JSONL 记录包含 UTC 时间、服务、事件、进程编号及相应字段。Node 和各 Gunicorn 工作进程使用独立文件，避免多进程轮转竞争。

- 操作记录：HTTP 方法、路由模板或操作名、状态码、耗时、已认证用户内部编号。Homeworks 原有数据库审计继续保留，同时向文件输出操作名和用户编号。
- 登录记录：成功登录的用户编号和角色、失败登录尝试的邮箱摘要，以及两个 Python 子系统的 SSO 成败。不记录密码、Token、API Key、请求正文或 URL 查询参数。失败邮箱摘要用于关联尝试，不是匿名化保证。
- 资源记录：Courseworks 的主机/容器采样、任务期限、准入申请/释放及回收事件；`aes-resource-monitor.service` 每 15 秒记录三个应用服务和 MySQL 的 cgroup CPU、内存、进程和 I/O 累积计数。CPU 使用率需按相邻采样的计数差计算。

普通操作记录反映请求完成与 HTTP 结果，不保证一次请求对应一次数据库提交，也不替代业务成绩和作业记录。可选旧调试日志可能包含模型内容，默认不开启，不应作为常规审计日志使用。

JSONL 文件默认权限 600，目录 700；单个进程/通道文件达到 20MiB 后轮转，最多保留 9 份旧文件。资源采样服务每小时清理最后修改时间超过 30 天的 JSONL 日志。服务输出由 logrotate 按天或 20MiB 轮转，保留 14 份。历史迁移日志不自动删改。日志写入失败不阻断业务请求，错误会写到服务错误输出。

```bash
find logs -maxdepth 2 -type f
tail -f logs/operations/courseworks-*.jsonl
tail -f logs/auth/courseworks-*.jsonl
systemctl status aes-resource-monitor
```

后续新增审计或统计功能应复用公共写入器，将日志放在 `logs/` 的相应分类中，不在子系统源码目录中另建生产日志目录。
