# AES 文档截图

此目录存放根目录 `README.md` 和 `INSTALL.md` 引用的系统截图。截图由 `scripts/generate_docs_screenshots.mjs` 自动生成，只使用隔离的临时数据库、虚构账号和 mock API，不读取 AES 的生产数据库。

Courseworks 的课程工作区、教师审阅模式和 OS Lab 截图统一使用浅色主题，以便在文档中保持清晰一致的显示效果。

文档测试数据统一使用 `example.edu` 邮箱、`.example` Provider 地址和虚构课程信息。AI Provider 示例为 DeepSeek V4 Pro、Kimi K3 和 GLM-5.3，不包含真实 API Key。

当前文件如下：

| 文件名 | 内容 |
| --- | --- |
| `login.png` | AES 登录页 |
| `portal-student.png` | 学生服务门户 |
| `portal-teacher.png` | 教师服务门户 |
| `provider-profiles.png` | AI Provider 管理 |
| `slideshow.png` | 课件浏览与问答 |
| `homeworks-student.png` | 学生作业页面 |
| `homeworks-grading.png` | 教师批改页面 |
| `courseworks.png` | Courseworks 编辑器和 AI 助手 |
| `os-lab.png` | Bash + QEMU + noVNC 操作系统实验环境 |
| `courseworks-audit.png` | 教师审阅模式 |
| `admin-console.png` | 超级管理员控制台 |
| `teacher-class-provider-quota-dialog.png` | 教师为班级指定 AI Provider 与每日配额的对话框 |

引用示例：

```markdown
![学生服务门户](docs/pictures/portal-student.png)
```

在仓库根目录运行以下命令可以重建全部截图：

```bash
node scripts/generate_docs_screenshots.mjs
```

脚本会临时启动 Courseworks 前端，以及使用临时 SQLite 数据的 Homeworks 和 Slideshow。运行环境需要 Google Chrome、Playwright、项目的 Node.js 依赖，以及 Homeworks/Slideshow 的 Python 依赖；可以通过 `PLAYWRIGHT_MODULE` 指定本机 `playwright/index.mjs` 的路径。脚本结束后会停止临时服务并删除临时数据。

更新截图时请遵循以下规则：

- 使用英文小写文件名，单词之间以连字符分隔；
- 使用 PNG 或 WebP，建议宽度为 1600 至 2400 像素；
- 不连接生产数据库，也不从生产页面截图；
- 只使用 `example.edu`、`.example` 和文档脚本中定义的虚构标识；
- AI Provider 不使用真实 Base URL 或 API Key；
- OS Lab 和教师审阅模式使用合成终端状态、学号和目录树，不启动真实实验或展示学生代码。
