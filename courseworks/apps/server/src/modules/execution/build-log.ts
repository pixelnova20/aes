/**
 * 文件作用：实现后端“沙箱执行、构建与 QEMU”业务模块中的 `summarizeBuildLog` 等能力。
 * 模块位置：`apps/server/src/modules/execution/build-log.ts`，属于后端“沙箱执行、构建与 QEMU”业务模块。
 * 重要函数：`summarizeBuildLog()` 负责汇总构建结果 日志。
 */
/**
 * 功能：汇总构建结果 日志。
 * 输入：`log`（string）提供日志。 `status`（string）提供状态。
 * 输出：返回该操作生成、查询或转换后的结果；异步实现以 Promise 交付结果。
 * 调用关系：由 `apps/server/src/modules/execution/build-runner.service.ts:runMakeBuild()` 调用；内部调用 `split()`。
 */
export function summarizeBuildLog(log: string, status: string) {
  const tail = log.split(/\r?\n/).slice(-40).join("\n");
  return `## Build ${status}\n\nLast log lines:\n\n\`\`\`text\n${tail}\n\`\`\``;
}
