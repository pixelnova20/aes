-- Add stable session/run metadata while keeping existing AgentRun rows readable.
ALTER TABLE `agent_runs`
    ADD COLUMN `session_id` VARCHAR(191) NULL,
    ADD COLUMN `run_sequence` INTEGER NULL,
    ADD COLUMN `model_name` VARCHAR(191) NULL;

CREATE INDEX `agent_runs_session_id_idx` ON `agent_runs`(`session_id`);
CREATE UNIQUE INDEX `agent_runs_session_id_run_sequence_key`
    ON `agent_runs`(`session_id`, `run_sequence`);

CREATE TABLE `evaluation_course_contexts` (
    `id` VARCHAR(191) NOT NULL,
    `workspace_id` VARCHAR(191) NOT NULL,
    `course_id` VARCHAR(191) NOT NULL,
    `course_title` VARCHAR(255) NOT NULL,
    `coursework_title` VARCHAR(255) NOT NULL,
    `coursework_version` VARCHAR(128) NULL,
    `semester` VARCHAR(64) NULL,
    `class_name` VARCHAR(255) NULL,
    `specification_sha256` VARCHAR(64) NULL,
    `initialized_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `evaluation_course_contexts_workspace_id_key`(`workspace_id`),
    PRIMARY KEY (`id`),
    CONSTRAINT `evaluation_course_contexts_workspace_id_fkey`
        FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`)
        ON DELETE RESTRICT ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `workspace_activity_events` (
    `id` VARCHAR(191) NOT NULL,
    `workspace_id` VARCHAR(191) NOT NULL,
    `actor_user_id` VARCHAR(191) NULL,
    `session_id` VARCHAR(191) NULL,
    `source` VARCHAR(64) NOT NULL,
    `event_type` VARCHAR(64) NOT NULL,
    `path` VARCHAR(1024) NULL,
    `before_sha256` VARCHAR(64) NULL,
    `after_sha256` VARCHAR(64) NULL,
    `agent_run_id` VARCHAR(191) NULL,
    `metadata_json` JSON NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `workspace_activity_events_workspace_id_created_at_idx`(`workspace_id`, `created_at`),
    INDEX `workspace_activity_events_agent_run_id_idx`(`agent_run_id`),
    INDEX `workspace_activity_events_actor_user_id_idx`(`actor_user_id`),
    PRIMARY KEY (`id`),
    CONSTRAINT `workspace_activity_events_workspace_id_fkey`
        FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`)
        ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT `workspace_activity_events_actor_user_id_fkey`
        FOREIGN KEY (`actor_user_id`) REFERENCES `users`(`id`)
        ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT `workspace_activity_events_agent_run_id_fkey`
        FOREIGN KEY (`agent_run_id`) REFERENCES `agent_runs`(`id`)
        ON DELETE SET NULL ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
