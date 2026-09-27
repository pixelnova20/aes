# AES 运维与内部组件

本文集中记录子系统共用的数据布局和运行环境。安装步骤见根目录的 `INSTALL.md`，用户操作见根目录的 `README.md`。

## 数据目录

- `accounts-data/accounts.db`：Homeworks 同步的用户、邀请码、班级关系和审计记录；
- `accounts-data/courses.db`：课程、章节、题库、班级、作业、提交和成绩；
- `accounts-data/slideshow.db`：课件元数据、班级归属、页面顺序和提取文本；
- `archive-data/`：删除账号、邀请码或班级前生成的恢复归档；
- `homeworks/uploads/`：题库附件和学生提交附件；
- `slideshow/uploads/`：PPT 原件、转换结果和页面图片；
- `courseworks/student-workspace/`：学生按课程隔离的工作区、会话和评价历史。

Courseworks 的 MySQL 数据库是认证和账户管理的主记录。账户变更会同步到 SQLite，供 Homeworks 和 Slideshow 做 SSO 与业务授权。备份和恢复必须使用同一个时间点的 MySQL、SQLite、上传目录、工作区和 `superuser.toml`。

## Slideshow 转换

上传 PPT/PPTX 后，Slideshow 使用 LibreOffice headless 转为 PDF，再由 Poppler `pdftoppm` 生成固定编号的 JPEG 页面。PPTX 内的页面 XML 会提取文本，供课件 AI 问答使用。当前不保留动画和切换效果，页面呈现以 LibreOffice 的静态转换结果为准。

## Courseworks Toolbox

Toolbox 镜像以非 root 的 `runner` 用户运行，提供课程实验常用工具，包括：

- RISC-V 交叉编译工具链、QEMU 和 noVNC；
- C/C++、Python、Shell 和常用构建工具；
- Tesseract OCR 与 Poppler PDF 工具；
- SDL、Cairo、FreeType、图像库、ncurses 和 LVGL 源码；
- 网络诊断命令，但学生容器受到受限网络策略约束。

Agent 命令、Shell、QEMU 和 runtime sidecar 使用不同的 CPU、内存和进程数档位，并受 `superuser.toml` 的统一安全上限约束。后端还限制工作区磁盘、终端数量、输出速率、会话寿命和全站 QEMU 并发。

## 受限网络

`courseworks/docker/toolbox/setup-restricted-network.sh` 创建 `courseworks-restricted` Docker 网络。默认阻止学生容器访问宿主机、局域网和其他私有网段，只允许必要的 DNS、HTTP/HTTPS、NTP 和 ICMP 外连。Agent 的普通命令沙箱默认使用 `--network none`，OS Lab 的 Bash 和 QEMU 使用受限网络。

部署后应检查 `courseworks/.env` 中的 `DOCKER_DIRECT_IFACE` 是否指向实际外网接口，并通过以下命令验证镜像和网络规则：

```bash
cd courseworks
npm run image:verify
bash tests/restricted-network-rules-test.sh
```
