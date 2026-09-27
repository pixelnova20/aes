/**
 * 文件作用：汇总并导出后端“长期课程任务”业务模块的公共 API。
 * 模块位置：`apps/server/src/modules/coursework/index.ts`，属于后端“长期课程任务”业务模块。
 * 重要函数：本文件以类型、常量、导出装配或启动副作用为主，不包含独立具名函数。
 */
export {
  getCourseTaskSnapshot,
  isInspectionOnlyPrompt,
  recordCourseTaskRunOutcome,
  resetCourseTaskContext,
  resolveCourseTaskContext,
  type AgentRunModeInput,
  type CourseTaskSnapshot,
} from "./course-task.service.js";
