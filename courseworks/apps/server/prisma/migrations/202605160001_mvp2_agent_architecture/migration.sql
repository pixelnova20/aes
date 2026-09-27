-- CreateTable
CREATE TABLE `agent_runs` (
    `id` VARCHAR(191) NOT NULL,
    `user_id` VARCHAR(191) NOT NULL,
    `workspace_id` VARCHAR(191) NOT NULL,
    `prompt` TEXT NOT NULL,
    `status` ENUM('created', 'context_collecting', 'context_collected', 'planning', 'planned', 'designing', 'design_generated', 'patch_generating', 'patch_generated', 'waiting_user_confirmation', 'patch_applying', 'patch_applied', 'build_running', 'build_success', 'build_failed', 'qemu_running', 'qemu_success', 'qemu_failed', 'analyzing', 'completed', 'failed', 'cancelled') NOT NULL DEFAULT 'created',
    `current_step` VARCHAR(191) NULL,
    `task_summary` TEXT NULL,
    `error_message` TEXT NULL,
    `started_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `finished_at` DATETIME(3) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    INDEX `agent_runs_user_id_idx`(`user_id`),
    INDEX `agent_runs_workspace_id_idx`(`workspace_id`),
    INDEX `agent_runs_status_idx`(`status`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `agent_trace_events` (
    `id` VARCHAR(191) NOT NULL,
    `agent_run_id` VARCHAR(191) NOT NULL,
    `step_name` VARCHAR(191) NOT NULL,
    `step_status` ENUM('pending', 'running', 'success', 'failed') NOT NULL,
    `input_summary_markdown` TEXT NULL,
    `output_summary_markdown` TEXT NULL,
    `error_markdown` TEXT NULL,
    `debug_markdown` TEXT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `agent_trace_events_agent_run_id_idx`(`agent_run_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `agent_patch_plans` (
    `id` VARCHAR(191) NOT NULL,
    `agent_run_id` VARCHAR(191) NOT NULL,
    `status` ENUM('generated', 'validation_failed', 'applied', 'failed') NOT NULL DEFAULT 'generated',
    `task_summary` TEXT NOT NULL,
    `design_markdown` TEXT NOT NULL,
    `modified_files_json` JSON NOT NULL,
    `patch` LONGTEXT NOT NULL,
    `student_explanation_markdown` TEXT NOT NULL,
    `validation_markdown` TEXT NOT NULL,
    `known_limitations_json` JSON NULL,
    `debug_markdown` TEXT NULL,
    `applied_at` DATETIME(3) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    INDEX `agent_patch_plans_agent_run_id_idx`(`agent_run_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `checkpoints` (
    `id` VARCHAR(191) NOT NULL,
    `agent_run_id` VARCHAR(191) NULL,
    `workspace_id` VARCHAR(191) NOT NULL,
    `label` VARCHAR(191) NOT NULL,
    `path` VARCHAR(191) NOT NULL,
    `status` ENUM('created', 'restored', 'failed') NOT NULL DEFAULT 'created',
    `result_markdown` TEXT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `restored_at` DATETIME(3) NULL,

    INDEX `checkpoints_agent_run_id_idx`(`agent_run_id`),
    INDEX `checkpoints_workspace_id_idx`(`workspace_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `build_runs` (
    `id` VARCHAR(191) NOT NULL,
    `agent_run_id` VARCHAR(191) NOT NULL,
    `workspace_id` VARCHAR(191) NOT NULL,
    `command` VARCHAR(191) NOT NULL DEFAULT 'make',
    `status` ENUM('queued', 'running', 'success', 'failed', 'timeout', 'error') NOT NULL DEFAULT 'running',
    `exit_code` INTEGER NULL,
    `log` LONGTEXT NOT NULL,
    `log_summary_markdown` TEXT NULL,
    `analysis_markdown` TEXT NULL,
    `started_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `finished_at` DATETIME(3) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `build_runs_agent_run_id_idx`(`agent_run_id`),
    INDEX `build_runs_workspace_id_idx`(`workspace_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `qemu_smoke_runs` (
    `id` VARCHAR(191) NOT NULL,
    `agent_run_id` VARCHAR(191) NOT NULL,
    `workspace_id` VARCHAR(191) NOT NULL,
    `command` VARCHAR(191) NOT NULL DEFAULT 'make qemu-smoke',
    `status` ENUM('queued', 'running', 'success', 'failed', 'timeout', 'error') NOT NULL DEFAULT 'running',
    `exit_code` INTEGER NULL,
    `output` LONGTEXT NOT NULL,
    `output_summary_markdown` TEXT NULL,
    `analysis_markdown` TEXT NULL,
    `started_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `finished_at` DATETIME(3) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `qemu_smoke_runs_agent_run_id_idx`(`agent_run_id`),
    INDEX `qemu_smoke_runs_workspace_id_idx`(`workspace_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `agent_runs` ADD CONSTRAINT `agent_runs_user_id_fkey` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `agent_runs` ADD CONSTRAINT `agent_runs_workspace_id_fkey` FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `agent_trace_events` ADD CONSTRAINT `agent_trace_events_agent_run_id_fkey` FOREIGN KEY (`agent_run_id`) REFERENCES `agent_runs`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `agent_patch_plans` ADD CONSTRAINT `agent_patch_plans_agent_run_id_fkey` FOREIGN KEY (`agent_run_id`) REFERENCES `agent_runs`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `checkpoints` ADD CONSTRAINT `checkpoints_agent_run_id_fkey` FOREIGN KEY (`agent_run_id`) REFERENCES `agent_runs`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `checkpoints` ADD CONSTRAINT `checkpoints_workspace_id_fkey` FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `build_runs` ADD CONSTRAINT `build_runs_agent_run_id_fkey` FOREIGN KEY (`agent_run_id`) REFERENCES `agent_runs`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `build_runs` ADD CONSTRAINT `build_runs_workspace_id_fkey` FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `qemu_smoke_runs` ADD CONSTRAINT `qemu_smoke_runs_agent_run_id_fkey` FOREIGN KEY (`agent_run_id`) REFERENCES `agent_runs`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `qemu_smoke_runs` ADD CONSTRAINT `qemu_smoke_runs_workspace_id_fkey` FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
-- 文件作用：建立 MVP2 Agent 架构所需的运行、Trace、补丁、构建、QEMU 与检查点数据表。
-- 模块位置：apps/server/prisma/migrations，属于数据库版本迁移层。
-- 重要操作：创建 Agent 相关枚举和表，并建立用户、工作区及运行记录之间的外键与索引。

