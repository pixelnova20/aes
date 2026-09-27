# Suite1 — MVP2 测试提示词（第 1 组）

## 测试流程

按顺序执行，每步完成后等待 Agent Run 结束再进入下一步。

| 步骤 | 文件 | 测试目标 | 预估耗时 |
|------|------|----------|----------|
| 1 | [suite1-step-1-task-setup.md](suite1-step-1-task-setup.md) | TaskLedger + WorkspaceFacts | ~30s |
| 2 | [suite1-step-2-task-recall.md](suite1-step-2-task-recall.md) | TaskLedger 记忆验证 | ~20s |
| 3 | [suite1-step-3-build-verify.md](suite1-step-3-build-verify.md) | VerificationLedger | ~30s |
| 4 | [suite1-step-4-facts-recall.md](suite1-step-4-facts-recall.md) | WorkspaceFacts + 多轮记忆 | ~20s |
| 5 | [suite1-step-5-topic-change.md](suite1-step-5-topic-change.md) | 会话不变性 | ~20s |
| 6 | [suite1-step-6-task-return.md](suite1-step-6-task-return.md) | 上下文纯净性 | ~20s |

## 与 Suite2 的区别

Suite1 的 prompt 更接近真实的 OS 课程实验场景（"为 MyVibeOS 创建最小项目骨架"），测试系统在 OS 场景下的端到端行为。

Suite2 的 prompt 更通用（"创建 hello.c 和 Makefile"），测试系统在非 OS 特定场景下的行为。
