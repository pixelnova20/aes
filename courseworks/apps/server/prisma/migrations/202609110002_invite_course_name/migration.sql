ALTER TABLE `invite_codes`
  ADD COLUMN `course_name` VARCHAR(255) NULL;

UPDATE `invite_codes` AS `invite`
LEFT JOIN `invite_code_uses` AS `use_record`
  ON `use_record`.`invite_code_id` = `invite`.`id`
LEFT JOIN `users` AS `registered_user`
  ON `registered_user`.`id` = `use_record`.`user_id`
SET `invite`.`course_name` = COALESCE(`registered_user`.`course_name`, 'Courseworks');

ALTER TABLE `invite_codes`
  MODIFY `course_name` VARCHAR(255) NOT NULL;
