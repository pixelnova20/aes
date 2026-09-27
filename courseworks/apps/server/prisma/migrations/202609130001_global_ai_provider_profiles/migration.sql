CREATE TABLE `ai_provider_profiles` (
    `id` VARCHAR(191) NOT NULL,
    `owner_email` VARCHAR(191) NOT NULL,
    `name` VARCHAR(128) NOT NULL,
    `base_url` VARCHAR(191) NOT NULL,
    `api_key` TEXT NOT NULL,
    `model` VARCHAR(191) NOT NULL,
    `level` ENUM('high', 'medium', 'low') NOT NULL DEFAULT 'medium',
    `temperature` DOUBLE NULL,
    `context_window_tokens` INTEGER NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    INDEX `ai_provider_profiles_owner_email_idx`(`owner_email`),
    UNIQUE INDEX `ai_provider_profiles_owner_email_name_key`(`owner_email`, `name`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `ai_provider_selections` (
    `owner_email` VARCHAR(191) NOT NULL,
    `profile_id` VARCHAR(191) NOT NULL,
    `updated_at` DATETIME(3) NOT NULL,

    UNIQUE INDEX `ai_provider_selections_profile_id_key`(`profile_id`),
    PRIMARY KEY (`owner_email`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `ai_provider_selections`
    ADD CONSTRAINT `ai_provider_selections_profile_id_fkey`
    FOREIGN KEY (`profile_id`) REFERENCES `ai_provider_profiles`(`id`)
    ON DELETE CASCADE ON UPDATE CASCADE;

INSERT INTO `ai_provider_profiles` (
    `id`, `owner_email`, `name`, `base_url`, `api_key`, `model`, `level`,
    `temperature`, `context_window_tokens`, `created_at`, `updated_at`
)
SELECT
    CONCAT('legacy-', settings.`id`),
    LOWER(users.`email`),
    '默认配置',
    settings.`base_url`,
    settings.`api_key`,
    settings.`model`,
    CASE
      WHEN settings.`reasoning_effort` = 'high' THEN 'high'
      WHEN settings.`reasoning_effort` = 'low' THEN 'low'
      ELSE 'medium'
    END,
    settings.`temperature`,
    settings.`context_window_tokens`,
    settings.`created_at`,
    settings.`updated_at`
FROM `ai_provider_settings` settings
INNER JOIN `users` users ON users.`id` = settings.`user_id`
WHERE NOT EXISTS (
    SELECT 1
    FROM `ai_provider_settings` newer_settings
    INNER JOIN `users` newer_users ON newer_users.`id` = newer_settings.`user_id`
    WHERE LOWER(newer_users.`email`) = LOWER(users.`email`)
      AND (
        newer_settings.`updated_at` > settings.`updated_at`
        OR (newer_settings.`updated_at` = settings.`updated_at` AND newer_settings.`id` > settings.`id`)
      )
);

INSERT INTO `ai_provider_selections` (`owner_email`, `profile_id`, `updated_at`)
SELECT `owner_email`, `id`, CURRENT_TIMESTAMP(3)
FROM `ai_provider_profiles`
WHERE `name` = '默认配置';
