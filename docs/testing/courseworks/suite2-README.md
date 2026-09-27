# Suite2 — MVP2 测试提示词（第 2 组）

## 为什么用短 prompt

当前版本中，`MAX_EARLIER_USER_MESSAGE_CHARS = 220` 会在第二轮追
问时把上一轮的长 prompt 截断到 220 字符。因此所有测试使用短
prompt（1-3 句话），避免截断干扰。

## 测试流程

按顺序执行，每步完成后等待 Agent Run 结束再进入下一步。

| 步骤 | 文件 | 测试目标 | 预估耗时 |
|------|------|----------|----------|
| 1 | [suite2-step-1-create-files.md](suite2-step-1-create-files.md) | TaskLedger + WorkspaceFacts 建立 | ~30s |
| 2 | [suite2-step-2-task-recall.md](suite2-step-2-task-recall.md) | TaskLedger 记忆验证 | ~20s |
| 3 | [suite2-step-3-build.md](suite2-step-3-build.md) | VerificationLedger 构建证据 | ~30s |
| 4 | [suite2-step-4-facts-recall.md](suite2-step-4-facts-recall.md) | WorkspaceFacts + 多轮记忆 | ~20s |
| 5 | [suite2-step-5-topic-change.md](suite2-step-5-topic-change.md) | 会话不变性 | ~20s |
| 6 | [suite2-step-6-task-return.md](suite2-step-6-task-return.md) | 上下文纯净性 | ~20s |

## 验收矩阵

| MVP2 能力 | 对应步骤 | 预期行为 |
|-----------|----------|----------|
| TaskLedger | 步骤 1→2 | 步骤 2 能回忆步骤 1 的任务目标 |
| VerificationLedger | 步骤 3→4 | 步骤 4 能回答构建结果 |
| WorkspaceFacts | 步骤 4 | context 包含 workspace_tree 和 relevant_files |
| ContextAssembler 增强 | 全部 | sourceRefs、reason、tokenEstimate 出现在 context preview |
| 会话不变性 | 步骤 5、6 | 话题变化后 sessionId 不变 |
| 上下文纯净性 | 步骤 6 | 回答聚焦 OS 任务，不被无关话题污染 |
| Omitted section | 全部 | context preview 说明排除的安全/平台目录 |

## 与 Suite1 的区别

Suite2 的 prompt 更通用（"创建 hello.c 和 Makefile"），测试系统在非 OS 特定场景下的行为。

Suite1 的 prompt 更接近真实的 OS 课程实验场景（"为 MyVibeOS 创建最小项目骨架"）。

## 注意事项

- 不要输入 `/new`（会重置 session 和 workspace）
- 每步 prompt 都很短（1-3 句话），直接复制引号内文本即可
- 可在任意步骤之间打开 context preview 观察 section 变化
- 如果某步 agent run 失败，等它完成后再进入下一步
