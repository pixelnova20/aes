CREATE TABLE `ai_model_profiles` (
  `id` VARCHAR(191) NOT NULL,
  `provider_name` VARCHAR(128) NULL,
  `model_name` VARCHAR(191) NOT NULL,
  `aliases` JSON NULL,
  `context_window_tokens` INTEGER NOT NULL,
  `effective_input_tokens` INTEGER NULL,
  `source_url` VARCHAR(512) NULL,
  `source_note` TEXT NULL,
  `is_active` BOOLEAN NOT NULL DEFAULT true,
  `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at` DATETIME(3) NOT NULL,

  UNIQUE INDEX `ai_model_profiles_model_name_key`(`model_name`),
  INDEX `ai_model_profiles_provider_name_idx`(`provider_name`),
  INDEX `ai_model_profiles_is_active_idx`(`is_active`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
-- 文件作用：建立可扩展 AI 模型档案表，保存上下文窗口、输出上限和模型来源。
-- 模块位置：apps/server/prisma/migrations，属于数据库版本迁移层。
-- 重要操作：创建 AiModelProfile 及其模型查找索引，支持本地模型与离线目录覆盖。
