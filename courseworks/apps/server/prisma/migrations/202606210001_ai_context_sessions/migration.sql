ALTER TABLE `ai_provider_settings`
  ADD COLUMN `context_window_tokens` INTEGER NULL;
-- 文件作用：为 AI 会话增加上下文 Session 标识，支持多轮消息连续性。
-- 模块位置：apps/server/prisma/migrations，属于数据库版本迁移层。
-- 重要操作：扩展 AI Provider 设置，使运行时能够定位持久化会话。
