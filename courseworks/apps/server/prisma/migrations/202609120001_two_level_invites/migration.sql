-- Introduce teacher-only level-1 invitations and class-bound level-2 invitations.
ALTER TABLE `invite_codes`
  ADD COLUMN `level` ENUM('level_1', 'level_2') NOT NULL DEFAULT 'level_1',
  ADD COLUMN `next_class_sequence` INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN `parent_invite_code_id` VARCHAR(191) NULL;

ALTER TABLE `invite_codes`
  DROP INDEX `invite_codes_teacher_user_id_key`,
  ADD INDEX `invite_codes_teacher_user_id_idx` (`teacher_user_id`),
  MODIFY `course_name` VARCHAR(255) NULL,
  MODIFY `class_name` VARCHAR(191) NULL;

-- Existing deployments used one class invitation for both the teacher and students.
-- Associate each legacy invitation with its teacher before splitting it in two.
UPDATE `invite_codes` AS `invite`
SET `invite`.`teacher_user_id` = (
  SELECT `candidate`.`id`
  FROM (
    SELECT `user`.`id`, `user`.`invite_code_id`
    FROM `users` AS `user`
    WHERE `user`.`role` = 'teacher'
  ) AS `candidate`
  WHERE `candidate`.`invite_code_id` = `invite`.`id`
  LIMIT 1
)
WHERE `invite`.`teacher_user_id` IS NULL;

-- Preserve each legacy class as the first level-2 invitation of its teacher.
INSERT INTO `invite_codes` (
  `id`, `code`, `description`, `level`, `course_name`, `class_name`, `max_uses`,
  `used_count`, `expires_at`, `is_active`, `created_at`, `updated_at`,
  `next_class_sequence`, `teacher_user_id`, `parent_invite_code_id`
)
SELECT
  CONCAT('migrated_', REPLACE(UUID(), '-', '')),
  CONCAT(`parent`.`code`, '-001'),
  CONCAT('Migrated class for ', `parent`.`code`),
  'level_2',
  `parent`.`course_name`,
  `parent`.`class_name`,
  `parent`.`max_uses`,
  (SELECT COUNT(*) FROM `users` AS `member`
    WHERE `member`.`invite_code_id` = `parent`.`id` AND `member`.`role` IN ('student', 'ta')),
  NULL,
  `parent`.`is_active`,
  `parent`.`created_at`,
  `parent`.`updated_at`,
  1,
  `parent`.`teacher_user_id`,
  `parent`.`id`
FROM `invite_codes` AS `parent`
WHERE `parent`.`teacher_user_id` IS NOT NULL
  AND `parent`.`course_name` IS NOT NULL
  AND `parent`.`class_name` IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM `invite_codes` AS `existing`
    WHERE `existing`.`code` = CONCAT(`parent`.`code`, '-001')
  );

UPDATE `users` AS `member`
JOIN `invite_codes` AS `child`
  ON `child`.`parent_invite_code_id` = `member`.`invite_code_id`
 AND `child`.`code` LIKE '%-001'
SET `member`.`invite_code_id` = `child`.`id`
WHERE `member`.`role` IN ('student', 'ta');

UPDATE `invite_code_uses` AS `usage`
JOIN `users` AS `member` ON `member`.`id` = `usage`.`user_id`
SET `usage`.`invite_code_id` = `member`.`invite_code_id`
WHERE `member`.`role` IN ('student', 'ta');

UPDATE `invite_codes`
SET `used_count` = CASE WHEN `teacher_user_id` IS NULL THEN 0 ELSE 1 END,
    `max_uses` = 1,
    `expires_at` = NULL,
    `course_name` = NULL,
    `class_name` = NULL,
    `next_class_sequence` = CASE
      WHEN EXISTS (
        SELECT 1 FROM (SELECT `parent_invite_code_id` FROM `invite_codes`) AS `children`
        WHERE `children`.`parent_invite_code_id` = `invite_codes`.`id`
      ) THEN 2 ELSE 1 END
WHERE `level` = 'level_1';

ALTER TABLE `users`
  DROP INDEX `users_email_key`,
  DROP INDEX `users_student_no_key`,
  ADD UNIQUE INDEX `users_email_invite_code_id_key` (`email`, `invite_code_id`),
  ADD UNIQUE INDEX `users_student_no_invite_code_id_key` (`student_no`, `invite_code_id`),
  ADD INDEX `users_email_idx` (`email`);

ALTER TABLE `invite_codes`
  ADD INDEX `invite_codes_parent_invite_code_id_idx` (`parent_invite_code_id`),
  ADD CONSTRAINT `invite_codes_parent_invite_code_id_fkey`
    FOREIGN KEY (`parent_invite_code_id`) REFERENCES `invite_codes` (`id`)
    ON DELETE RESTRICT ON UPDATE CASCADE;
