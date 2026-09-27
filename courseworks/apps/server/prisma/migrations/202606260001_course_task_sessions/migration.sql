CREATE TABLE `course_task_sessions` (
  `id` VARCHAR(191) NOT NULL,
  `user_id` VARCHAR(191) NOT NULL,
  `workspace_id` VARCHAR(191) NOT NULL,
  `title` VARCHAR(255) NOT NULL,
  `status` ENUM('active', 'paused', 'completed') NOT NULL DEFAULT 'active',
  `summary_markdown` TEXT NULL,
  `current_subtask_id` VARCHAR(191) NULL,
  `last_run_id` VARCHAR(191) NULL,
  `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

  INDEX `course_task_sessions_user_id_idx`(`user_id`),
  INDEX `course_task_sessions_workspace_id_idx`(`workspace_id`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `course_subtasks` (
  `id` VARCHAR(191) NOT NULL,
  `course_task_session_id` VARCHAR(191) NOT NULL,
  `title` VARCHAR(255) NOT NULL,
  `goal_markdown` TEXT NULL,
  `status` ENUM('active', 'blocked', 'done') NOT NULL DEFAULT 'active',
  `latest_user_intent` TEXT NULL,
  `last_validation_summary` TEXT NULL,
  `last_build_status` ENUM('queued', 'running', 'success', 'failed', 'timeout', 'error') NULL,
  `last_qemu_status` ENUM('queued', 'running', 'success', 'failed', 'timeout', 'error') NULL,
  `last_run_id` VARCHAR(191) NULL,
  `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

  INDEX `course_subtasks_course_task_session_id_idx`(`course_task_session_id`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `course_subtask_files` (
  `id` VARCHAR(191) NOT NULL,
  `course_subtask_id` VARCHAR(191) NOT NULL,
  `path` VARCHAR(191) NOT NULL,
  `kind` VARCHAR(32) NOT NULL,
  `updated_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

  INDEX `course_subtask_files_course_subtask_id_idx`(`course_subtask_id`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `agent_runs`
  ADD COLUMN `course_task_session_id` VARCHAR(191) NULL,
  ADD COLUMN `course_subtask_id` VARCHAR(191) NULL,
  ADD COLUMN `run_mode` ENUM('continue_subtask', 'new_subtask', 'reset_context_then_run') NULL,
  ADD COLUMN `final_answer_markdown` TEXT NULL,
  ADD COLUMN `activity_log_markdown` LONGTEXT NULL;

ALTER TABLE `agent_runs`
  ADD INDEX `agent_runs_course_task_session_id_idx`(`course_task_session_id`),
  ADD INDEX `agent_runs_course_subtask_id_idx`(`course_subtask_id`);

ALTER TABLE `course_task_sessions`
  ADD CONSTRAINT `course_task_sessions_user_id_fkey`
    FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT `course_task_sessions_workspace_id_fkey`
    FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE `course_subtasks`
  ADD CONSTRAINT `course_subtasks_course_task_session_id_fkey`
    FOREIGN KEY (`course_task_session_id`) REFERENCES `course_task_sessions`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE `course_subtask_files`
  ADD CONSTRAINT `course_subtask_files_course_subtask_id_fkey`
    FOREIGN KEY (`course_subtask_id`) REFERENCES `course_subtasks`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE `agent_runs`
  ADD CONSTRAINT `agent_runs_course_task_session_id_fkey`
    FOREIGN KEY (`course_task_session_id`) REFERENCES `course_task_sessions`(`id`) ON DELETE SET NULL ON UPDATE CASCADE,
  ADD CONSTRAINT `agent_runs_course_subtask_id_fkey`
    FOREIGN KEY (`course_subtask_id`) REFERENCES `course_subtasks`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
-- 文件作用：建立长期课程任务、子任务及其文件记录的数据结构。
-- 模块位置：apps/server/prisma/migrations，属于数据库版本迁移层。
-- 重要操作：创建 CourseTaskSession、CourseSubtask 和 CourseSubtaskFile，并关联用户与 Agent Run。
