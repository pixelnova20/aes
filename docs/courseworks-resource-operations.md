# Courseworks 资源回收与运行日志

资源日志接入 `management` 公共日志模块，使用根目录 `logs/resources/courseworks-<pid>.jsonl`；根目录可通过 `AES_LOG_ROOT` 配置。集中存储及日志格式见 [数据与运行日志](storage-and-logging.md)，Agent 超时及自动续跑见 [Agent 进度策略](agent-progress-policy.md)。

当前实现针对单后端实例管理 Docker 容器的部署方式。容器 CPU、内存、进程数和全局准入预算应按部署主机容量配置，并通过日志评估真实负载。

## 回收规则

- Docker 采样先用 `docker ps` 按 Courseworks 标签筛选，再对明确的容器名称调用 `docker stats`。不再使用 `docker stats --filter`。
- 空闲和最长生存期检查独立执行，不依赖采样成功。Docker 查询有超时，查询失败会记录事件。
- OS Lab Shell 默认空闲 30 分钟回收；有输入或输出会更新活动时间，单次会话最长 2 小时。最后一个 Shell 删除后回收工作区 sidecar。磁盘工作区文件不会因会话回收而删除。
- 重新进入 OS Lab 时，先等待旧会话和 sidecar 清理完成、额度释放，再创建新会话，避免新旧实例短暂叠加导致误报繁忙。
- 正常满 CPU 编译、接近内存上限不再直接触发误杀。CPU、内存、进程数仍受 Docker cgroup 硬上限约束，另外保留输出洪泛、磁盘额度及超时控制。
- Bash 工具按工作区申请重任务额度，排队取消会立即撤销等待项。单个命令默认 30 秒，硬上限 60 秒，沿用生产配置。
- Agent Run 默认不设固定总时长上限，通过模型静默、无进展及重复工具结果检测停止异常任务；可用 `WORKSPACE_AGENT_RUN_TIMEOUT_MS` 显式启用总期限。工具容器仍有各自的硬超时。
- 容器删除失败会重试；删除成功或确认容器不存在后才释放对应准入额度。Docker 本身异常时可能继续显示资源繁忙，这是保留真实占用的保护行为。
- 若超时发生在 Docker 尚未完成创建时，会保留最多 30 秒的创建观察窗口，重复清理迟到的容器。`docker rm -f` 的成功退出码不一定代表删除了容器，还需检查返回值。超过该窗口才出现的异常遗留容器由周期巡检继续回收。
- 后端启动时先等待旧受管容器清理完成，再接收请求。运行中发现不在本实例登记表中的受管容器，观察 60 秒后回收。

注意：当前登记表与准入器是进程内状态，因此不能让两个后端实例共用同一组 `courseworks.managed=true` 容器。扩展为多实例前必须增加实例归属和共享协调机制。重启后端也会结束已有交互会话。

## 日志位置与保留

生产日志位于：

```text
<AES_ROOT>/logs/resources/courseworks-<pid>.jsonl
```

可通过环境变量 `AES_LOG_ROOT` 指定日志根目录，默认是 AES 根目录下的 `logs`。每行是一个 JSON 对象，包含时间和事件信息。

每个文件约 20 MiB，保留当前文件及 9 个轮转文件，总量约 200 MiB。目录权限为 700，新日志文件权限为 600。异步写入队列有上限，丢弃数量写入 `droppedEvents`；写入失败会在服务日志中出现 `resource_log_error`。

新资源日志仅记录指标和内部关联 ID，不记录邮箱、密码、API Key、聊天内容、命令正文、作业正文或工作区文件路径。内部 ID 仍需作为运维信息保护。日志目录已被仓库忽略。

## 事件与统计用途

| 事件 | 主要指标 | 用途 |
| --- | --- | --- |
| `host_sample` | 可用内存、Swap 用量、load average、CPU/内存/I/O PSI、后端 RSS、准入占用与等待数 | 区分额度不足与实际主机压力 |
| `container_sample` | CPU 核数用量、内存字节、进程数、硬上限、存活/空闲时间、I/O 计数 | 按工作区与任务类型分析负载 |
| `container_registered` / `container_finished` | 类型、工作区/Run ID、存活时间、样本数及采样峰值 | 分析活跃会话及利用率 |
| `container_terminated` | 空闲、最长生命周期、磁盘额度、输出洪泛等原因 | 检查主动回收是否合理 |
| `container_removed` / `container_cleanup_retry` | 实际清理耗时、重试次数/错误码 | 识别 Docker 清理延迟与失败 |
| `admission_*` | 申请、等待、拒绝、超时、取消、释放、预算快照 | 统计繁忙率、等待时间及占用时长 |
| `agent_run_started` / `agent_run_finished` / `agent_run_timeout` | Run ID、工作区、持续时间和期限 | 分析整轮 Agent 行为 |
| `tool_exit` / `tool_timeout` / `tool_cancelled` | 容器、Run ID、退出码及终止原因 | 分析 Bash 工具执行结果 |
| `monitor_error` / `orphan_removed` / `startup_reconciled` | 监控失败、遗留容器回收、启动清理数量 | 运维异常排查 |

主机和容器指标约每 15 秒写入日志，生命周期事件即时写入异步队列；Docker 采样周期沿用配置，生产为 2 秒。采样峰值不是操作系统提供的精确历史峰值，短命令可能没有样本，`samples=0` 时不可把峰值 0 当作没有资源消耗。日志适合容量评估，不适合精确计费。

## 运维查看

```bash
# 最近的资源事件
tail -n 30 ~/aes/logs/resources/courseworks-*.jsonl

# Docker/日志写入错误及服务状态
journalctl -u courseworks-backend.service --since '1 hour ago' --no-pager
systemctl status courseworks-backend.service --no-pager

# 当前受管容器
docker ps -a --filter label=courseworks.managed=true
```

分析时优先关注准入拒绝/超时比例、等待时间分位数、Shell 空闲占比、容器清理重试、可用内存低谷及 I/O PSI。CPU 采样的 1.0 表示约使用一个 CPU 核，并非整机利用率 100%。不能直接用注册用户数推算最大并发，也不应把空闲容器数量等同于实际 CPU 负载。

通过后端环境配置调整期限。修改 systemd drop-in 后需执行 `systemctl daemon-reload` 并在合适时段重启服务。调整全局内存预算时，应先为 MySQL、Python 服务、Node、Docker 和系统缓存留出余量，并结合连续课堂负载的测量结果。

## OS Lab 断线与回收

普通 OS Lab 页面使用独立的 WebSocket 跟踪连接，切换页面内的 Bash 标签不会触发回收。异常断线后重新连接可以恢复仍存活的 Bash 及其终端输出。

Nginx 需为 `/api/workspace/lab/presence` 转发 WebSocket Upgrade；项目的 `courseworks/scripts/nginx-courseworks.conf` 已包含该规则。已有部署升级时也需要更新代理规则并检查、重载 Nginx。

- 关闭 Bash 标签立即停止该 Bash；关闭最后一个 Bash 不会自动创建替代会话。
- 点击返回工作区主动退出时，若没有其他 OS Lab 页面连接，立即停止该工作区的 Lab Bash 会话。
- 浏览器触发 `pagehide` 时主动发送退出消息；最后一个页面退出后立即开始清理。浏览器无法可靠区分关闭标签页、刷新和页面导航，因此刷新也会结束旧 Bash；重新打开时创建新会话。其他页面仍连接时继续保留共享会话。
- 如果浏览器崩溃、断网或系统强制结束，退出消息可能无法送达；此时连接断开仍使用 60 秒重连窗口。服务器每 20 秒发送 WebSocket Ping，连续未收到 Pong 时终止连接，因此无声断网还需约 20–40 秒检测时间。
- 一个页面内的后台 Bash 标签以及其他仍连接的 OS Lab 页面受到保护。辅助容器仅在最后一个依赖它的 Bash 容器完成清理后回收；Bash 内的子进程随该容器结束。Agent Run 自己创建的 QEMU、工具容器不由页面断线清理。
- 回收不删除工作区中的已保存文件；内存中的 Bash 状态、未保存数据和仍运行的实验进程会结束。原有空闲、最长生命周期等限制仍然生效。

日志新增 `lab_connected`、`lab_disconnected`、`lab_disconnect_pending`、`lab_disconnect_expired`、`lab_explicit_exit`，通过工作区 ID 与容器、准入事件关联。部署后已打开的旧页面需刷新一次以启用新连接协议。

2026-10-13 生产验证：异常断线重连保留 Bash 会话 ID、变量和输出；关闭一个 Bash 不影响另一个 Bash 及辅助容器。未主动通知退出时，最后一个页面断开后第 60 秒触发清理，约第 72 秒容器及准入占用全部归零；主动退出约 12 秒完成清理。已保存的独立测试文件在回收后仍保留，验证结束后删除。上述时间包含该机器的 Docker 清理耗时，不代表固定完成时限。

## 当前性能边界

部署验证时还观察到较高的磁盘 I/O 等待和较慢的 Docker 冷启动。在容器尚未完成创建时立即重置 OS Lab，一次测试请求超过了 45 秒，但后台随后完成了清理和重建。这与永久占用准入额度是不同的问题，本次没有通过放宽内存或跳过清理来掩盖启动延迟。

下一步应结合日志测量正常课堂负载下的冷启动、重置、清理时间，以及 I/O PSI，决定是否迁移 Docker 存储到更快的磁盘、改造同步启动调用、增加有容量上限的预热池。当前尚未实现按实时使用量动态调整容器内存配额。
