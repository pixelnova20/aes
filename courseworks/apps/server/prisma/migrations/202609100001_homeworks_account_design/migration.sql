ALTER TABLE `users`
  ADD COLUMN `name` VARCHAR(255) NULL,
  ADD COLUMN `student_no` VARCHAR(64) NULL,
  ADD COLUMN `course_name` VARCHAR(255) NULL;

CREATE UNIQUE INDEX `users_student_no_key` ON `users`(`student_no`);

UPDATE `users` SET `role` = 'super_admin' WHERE `role` = 'admin';

ALTER TABLE `users`
  MODIFY `role` ENUM('super_admin', 'teacher', 'ta', 'student') NOT NULL;
