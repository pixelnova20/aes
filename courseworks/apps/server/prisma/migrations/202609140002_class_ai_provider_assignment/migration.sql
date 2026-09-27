CREATE TABLE `class_ai_provider_assignments` (
    `id` VARCHAR(191) NOT NULL,
    `class_invite_id` VARCHAR(191) NOT NULL,
    `profile_id` VARCHAR(191) NOT NULL,
    `teacher_user_id` VARCHAR(191) NOT NULL,
    `enforced` BOOLEAN NOT NULL DEFAULT false,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    UNIQUE INDEX `class_ai_provider_assignments_class_invite_id_key`(`class_invite_id`),
    INDEX `class_ai_provider_assignments_profile_id_idx`(`profile_id`),
    INDEX `class_ai_provider_assignments_teacher_user_id_idx`(`teacher_user_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `class_ai_provider_assignments`
    ADD CONSTRAINT `class_ai_provider_assignments_class_invite_id_fkey`
    FOREIGN KEY (`class_invite_id`) REFERENCES `invite_codes`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE `class_ai_provider_assignments`
    ADD CONSTRAINT `class_ai_provider_assignments_profile_id_fkey`
    FOREIGN KEY (`profile_id`) REFERENCES `ai_provider_profiles`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE `class_ai_provider_assignments`
    ADD CONSTRAINT `class_ai_provider_assignments_teacher_user_id_fkey`
    FOREIGN KEY (`teacher_user_id`) REFERENCES `users`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
