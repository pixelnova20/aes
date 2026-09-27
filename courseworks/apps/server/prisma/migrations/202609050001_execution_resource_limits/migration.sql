ALTER TABLE `agent_runs`
  MODIFY `status` ENUM('created','context_collecting','context_collected','planning','planned','designing','design_generated','patch_generating','patch_generated','waiting_user_confirmation','patch_applying','patch_applied','build_running','build_success','build_failed','qemu_running','qemu_success','qemu_failed','analyzing','completed','failed','cancelled','resource_limit_exceeded','idle_timeout') NOT NULL DEFAULT 'created';

ALTER TABLE `build_runs`
  MODIFY `status` ENUM('queued','running','success','failed','timeout','error','resource_limit_exceeded','idle_timeout') NOT NULL DEFAULT 'running';

ALTER TABLE `qemu_smoke_runs`
  MODIFY `status` ENUM('queued','running','success','failed','timeout','error','resource_limit_exceeded','idle_timeout') NOT NULL DEFAULT 'running';
