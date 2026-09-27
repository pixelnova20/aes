/**
 * 文件作用：实现后端“沙箱执行、构建与 QEMU”业务模块中的 `summarizeQemuOutput` 等能力。
 * 模块位置：`apps/server/src/modules/execution/qemu-output.ts`，属于后端“沙箱执行、构建与 QEMU”业务模块。
 * 重要函数：`summarizeQemuOutput()` 负责汇总QEMU 输出。
 */
/**
 * 功能：汇总QEMU 输出。
 * 输入：`output`（string）提供输出。 `status`（string）提供状态。
 * 输出：返回该操作生成、查询或转换后的结果；异步实现以 Promise 交付结果。
 * 调用关系：由 `apps/server/src/modules/execution/qemu-smoke-runner.service.ts:runQemuSmoke()` 调用；内部调用 `split()`。
 */
export function summarizeQemuOutput(output: string, status: string) {
  const tail = output.split(/\r?\n/).slice(-40).join("\n");
  return `## QEMU Smoke ${status}\n\nSerial output tail:\n\n\`\`\`text\n${tail}\n\`\`\``;
}
