/**
 * 文件作用：实现后端“课程会话与历史记录”业务模块中的 `buildStudentSessionKey`、`normalizeSessionOwner` 等能力。
 * 模块位置：`apps/server/src/modules/conversations/session-key.ts`，属于后端“课程会话与历史记录”业务模块。
 * 重要函数：`buildStudentSessionKey()` 负责构建`student` 会话 `key`；`normalizeSessionOwner()` 负责规范化会话 归属信息。
 */
import type { SessionOwner, StudentSessionKey } from "./session-types.js";

export const DEFAULT_COURSE_ID = "os";

// 统一生成逻辑会话键，避免不同模块各自拼字符串，导致同一学生被拆成多个会话。
/**
 * 功能：构建`student` 会话 `key`。
 * 输入：`owner`（SessionOwner）提供归属信息。
 * 输出：返回 StudentSessionKey，供调用方继续处理。
 * 调用关系：由 `apps/server/src/modules/conversations/chat-session.service.ts:resolveSessionStoreContext()` 调用。
 */
export function buildStudentSessionKey(owner: SessionOwner): StudentSessionKey {
  return {
    scope: "course_student",
    courseId: owner.courseId,
    userId: owner.userId,
    value: `course:${owner.courseId}:user:${owner.userId}`
  };
}

/**
 * 功能：规范化会话 归属信息。
 * 输入：`owner`（Partial<SessionOwner> | undefined）提供归属信息。 `fallbackUserId`（string）提供fallback 用户 id。
 * 输出：返回 SessionOwner，供调用方继续处理。
 * 调用关系：由 `apps/server/src/modules/conversations/chat-session.service.ts:resolveOwner()` 调用。
 */
export function normalizeSessionOwner(owner: Partial<SessionOwner> | undefined, fallbackUserId: string): SessionOwner {
  return {
    courseId: owner?.courseId?.trim() || DEFAULT_COURSE_ID,
    userId: owner?.userId?.trim() || fallbackUserId,
    workspaceId: owner?.workspaceId ?? null
  };
}
