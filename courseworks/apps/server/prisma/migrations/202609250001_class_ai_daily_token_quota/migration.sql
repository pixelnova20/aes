ALTER TABLE `class_ai_provider_assignments`
    ADD COLUMN `daily_token_limit` INTEGER NULL;

CREATE TABLE `class_ai_token_usages` (
    `id` VARCHAR(191) NOT NULL,
    `assignment_id` VARCHAR(191) NOT NULL,
    `user_id` VARCHAR(191) NOT NULL,
    `usage_date` CHAR(10) NOT NULL,
    `used_tokens` INTEGER NOT NULL DEFAULT 0,
    `reserved_tokens` INTEGER NOT NULL DEFAULT 0,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    UNIQUE INDEX `class_ai_token_usages_assignment_id_user_id_usage_date_key`(`assignment_id`, `user_id`, `usage_date`),
    INDEX `class_ai_token_usages_user_id_usage_date_idx`(`user_id`, `usage_date`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `class_ai_token_usages`
    ADD CONSTRAINT `class_ai_token_usages_assignment_id_fkey`
    FOREIGN KEY (`assignment_id`) REFERENCES `class_ai_provider_assignments`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE `class_ai_token_usages`
    ADD CONSTRAINT `class_ai_token_usages_user_id_fkey`
    FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
