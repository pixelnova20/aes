-- Persist the class currently selected by a teacher across portal sessions.
ALTER TABLE `users`
  ADD COLUMN `current_class_invite_id` VARCHAR(191) NULL,
  ADD INDEX `users_current_class_invite_id_idx` (`current_class_invite_id`),
  ADD CONSTRAINT `users_current_class_invite_id_fkey`
    FOREIGN KEY (`current_class_invite_id`) REFERENCES `invite_codes` (`id`)
    ON DELETE SET NULL ON UPDATE CASCADE;

-- Existing teachers start in their first active class, ordered by invitation code.
UPDATE `users` AS `teacher`
SET `teacher`.`current_class_invite_id` = (
  SELECT `candidate`.`id`
  FROM `invite_codes` AS `candidate`
  WHERE `candidate`.`teacher_user_id` = `teacher`.`id`
    AND `candidate`.`level` = 'level_2'
    AND `candidate`.`is_active` = true
  ORDER BY `candidate`.`code` ASC
  LIMIT 1
)
WHERE `teacher`.`role` = 'teacher'
  AND `teacher`.`current_class_invite_id` IS NULL;
