ALTER TABLE `agent_runs`
  ADD COLUMN `intent` VARCHAR(64) NULL,
  ADD COLUMN `response_markdown` TEXT NULL;
-- 文件作用：为 Agent Run 增加意图路由所需的数据字段。
-- 模块位置：apps/server/prisma/migrations，属于数据库版本迁移层。
-- 重要操作：扩展 Agent Run 数据结构，使应用能够保存识别出的任务意图。
