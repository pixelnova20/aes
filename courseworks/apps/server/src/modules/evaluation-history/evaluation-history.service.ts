/**
 * 文件作用：维护学生工作区的长期评价历史。
 * 模块位置：`apps/server/src/modules/evaluation-history/evaluation-history.service.ts`。
 * 设计原则：活动会话写入一个 Markdown；`/new` 前将旧会话写入 `past_sessions`；附件写入 `artifacts_history`。
 */
import fs from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";

import { Prisma } from "@prisma/client";
import { prisma } from "../../infrastructure/prisma/client.js";
import { assertWorkspaceWriteAllowed } from "../workspaces/index.js";
import {
  DEFAULT_COURSE_ID,
  listChatSessions,
  readChatSessionHistory,
  type ChatHistoryMessage,
  type StudentSession,
} from "../conversations/index.js";
import { listConsumedArtifactsForSession } from "../artifacts/index.js";
import { evaluationHistoryRoot as artifactEvaluationHistoryRoot, pastSessionsRoot } from "../artifacts/index.js";

const HISTORY_FILE = "session-history.md";
const MANAGED_MARKER = "<!-- courseworks-evaluation-history:v3 -->";

type EvaluationAttachment = {
  id: string;
  originalName: string;
  mimeType: string;
  sizeBytes: number;
  sha256: string;
  relativePath: string;
  archived: boolean;
  runId?: string;
};

type EvaluationMessage = {
  id: string;
  role: "user" | "assistant";
  content: string;
  createdAt: string;
  runId?: string;
  attachments: EvaluationAttachment[];
};

type EvaluationConversation = {
  sessionId: string;
  title: string;
  status: string;
  createdAt: string;
  updatedAt: string;
  closedAt?: string;
  messages?: EvaluationMessage[];
  userPrompts: Array<{ content: string; createdAt: string }>;
  assistantMessages: number;
};

type EvaluationValidation = {
  kind?: "build" | "qemu";
  status: string;
  command: string;
  exitCode?: number;
  summary?: string;
  createdAt?: string;
};

type EvaluationRun = {
  id: string;
  sessionId?: string;
  sequence?: number;
  modelName?: string;
  status: string;
  prompt: string;
  finalAnswer: string;
  errorMessage?: string;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  tools: string[];
  retries: number;
  compactions: number;
  validations?: EvaluationValidation[];
  build?: EvaluationValidation;
  qemu?: EvaluationValidation;
  attachments?: EvaluationAttachment[];
};

type EvaluationSubtask = {
  title: string;
  status: string;
  goal?: string;
  validation?: string;
  buildStatus?: string;
  qemuStatus?: string;
  files: string[];
};

type EvaluationCourseTask = {
  title: string;
  status: string;
  summary?: string;
  createdAt: string;
  updatedAt: string;
  subtasks: EvaluationSubtask[];
};

type EvaluationCheckpoint = {
  id: string;
  label: string;
  status: string;
  createdAt: string;
  restoredAt?: string;
};

type EvaluationCourseInformation = {
  courseId: string;
  courseTitle: string;
  courseworkTitle: string;
  courseworkVersion?: string;
  semester?: string;
  className?: string;
  specificationSha256?: string;
  initializedAt: string;
};

type EvaluationPastSession = {
  fileName: string;
  sessionId: string;
  archivedAt: string;
  reason?: string;
  runCount?: number;
  validationSummary?: string;
};

type EvaluationActivityEvent = {
  id: string;
  eventType: string;
  path?: string;
  actorUserId?: string;
  sessionId?: string;
  runId?: string;
  beforeSha256?: string;
  afterSha256?: string;
  createdAt: string;
};

type WorkspaceFileSnapshot = {
  path: string;
  sizeBytes: number;
  sha256: string;
};

export type EvaluationHistorySnapshot = {
  generatedAt: string;
  studentEmail: string;
  studentUserId?: string;
  workspaceUuid: string;
  workspaceStatus: string;
  workspaceUpdatedAt?: string;
  courseInformation?: EvaluationCourseInformation;
  currentSessionId?: string;
  conversations: EvaluationConversation[];
  runs: EvaluationRun[];
  validations?: EvaluationValidation[];
  courseTasks: EvaluationCourseTask[];
  checkpoints: EvaluationCheckpoint[];
  pastSessions?: EvaluationPastSession[];
  activityEvents?: EvaluationActivityEvent[];
  archivedAt?: string;
  archiveReason?: string;
  workspaceFiles?: WorkspaceFileSnapshot[];
};

export type EvaluationHistoryRefreshResult = {
  filePath: string;
  runCount: number;
  conversationCount: number;
};

export type WorkspaceMutation = {
  eventType: "file.write" | "directory.create" | "file.create" | "file.delete" | "directory.delete" | "workspace.import" | "upload.stage" | "upload.discard";
  path: string;
  beforeSha256?: string;
  afterSha256?: string;
  metadata?: Record<string, string | number | boolean | null>;
};

const refreshQueues = new Map<string, Promise<EvaluationHistoryRefreshResult>>();

export async function recordWorkspaceActivityEvent(args: {
  workspaceId: string;
  actorUserId?: string;
  sessionId?: string;
  runId?: string;
  source?: string;
  mutation: WorkspaceMutation;
}) {
  await prisma.workspaceActivityEvent.create({
    data: {
      workspaceId: args.workspaceId,
      actorUserId: args.actorUserId,
      sessionId: args.sessionId,
      source: args.source ?? "agent",
      eventType: args.mutation.eventType,
      path: args.mutation.path,
      beforeSha256: args.mutation.beforeSha256,
      afterSha256: args.mutation.afterSha256,
      agentRunId: args.runId,
      metadataJson: args.mutation.metadata ? (args.mutation.metadata as Prisma.InputJsonValue) : undefined,
    },
  });
}

export function evaluationHistoryRoot(workspacePath: string) {
  return artifactEvaluationHistoryRoot(workspacePath);
}

export function evaluationHistoryFilePath(workspacePath: string) {
  return path.join(evaluationHistoryRoot(workspacePath), HISTORY_FILE);
}

function formatSecond(value: string | Date | undefined) {
  if (!value) return "not recorded";
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.valueOf()) ? String(value) : date.toISOString().replace(/\.\d{3}Z$/, "Z");
}

function normalize(value: string | null | undefined) {
  return (value ?? "").trim().replace(/\r\n/g, "\n").replace(/\n{3,}/g, "\n\n");
}

function quote(value: string | null | undefined, fallback: string) {
  const content = normalize(value) || fallback;
  return content.split("\n").map((line) => `> ${line}`).join("\n");
}

function oneLine(value: string | null | undefined, fallback = "not recorded") {
  const content = normalize(value).replace(/\n/g, " ");
  return content || fallback;
}

function optionalNumber(value: number | null | undefined) {
  return value === null || value === undefined ? undefined : value;
}

function keepFinalVisibleMessages(messages: ChatHistoryMessage[]) {
  const result: ChatHistoryMessage[] = [];
  const assistantIndexByRun = new Map<string, number>();
  for (const message of messages) {
    if (message.role !== "assistant" || !message.runId) {
      result.push(message);
      continue;
    }
    const existingIndex = assistantIndexByRun.get(message.runId);
    if (existingIndex === undefined) {
      assistantIndexByRun.set(message.runId, result.length);
      result.push(message);
    } else {
      // Pi may emit several visible fragments around tool calls; evaluation history keeps the final one.
      result[existingIndex] = message;
    }
  }
  return result;
}

export function evaluationToolName(stepName: string) {
  if (stepName.startsWith("pi:tool:")) return stepName.slice("pi:tool:".length);
  if (stepName.startsWith("tool:")) return stepName.slice("tool:".length);
  return null;
}

const INITIAL_HISTORY = [
  MANAGED_MARKER,
  "# Student Coursework Evaluation History",
  "",
  "This file is maintained by Courseworks. It contains the current active session only; archived sessions are linked below.",
  "",
  "## Course Information",
  "",
  "_No coursework activity has been recorded yet._",
  "",
].join("\n");

export async function ensureEvaluationHistory(workspacePath: string) {
  const root = evaluationHistoryRoot(workspacePath);
  await fs.mkdir(root, { recursive: true, mode: 0o700 });
  await fs.mkdir(path.join(root, "artifacts_history"), { recursive: true, mode: 0o700 });
  await fs.mkdir(pastSessionsRoot(workspacePath), { recursive: true, mode: 0o700 });
  await fs.chmod(root, 0o700);
  const filePath = evaluationHistoryFilePath(workspacePath);
  try {
    await fs.writeFile(filePath, INITIAL_HISTORY, { encoding: "utf8", flag: "wx", mode: 0o600 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  return filePath;
}

function renderAttachment(attachment: EvaluationAttachment, archive: boolean) {
  const target = archive || attachment.archived
    ? `${archive ? "../" : ""}artifacts_history/${attachment.relativePath}`
    : `../.uploads/${attachment.relativePath}`;
  return `- [${attachment.originalName}](${target}) (${attachment.mimeType || "unknown"}, ${attachment.sizeBytes} bytes, sha256 \`${attachment.sha256}\`)`;
}

function renderValidation(validation: EvaluationValidation) {
  const exitCode = validation.exitCode === undefined ? "" : `, exit ${validation.exitCode}`;
  const status = ["success", "passed", "completed"].includes(validation.status) ? "passed" :
    ["not_run", "not-run", "pending"].includes(validation.status) ? "not run" : "failed";
  return `- **${(validation.kind ?? "validation").toUpperCase()}**: ${status} via \`${validation.command}\`${exitCode}`;
}

function renderConversation(lines: string[], session: EvaluationConversation, archive: boolean) {
  lines.push(
    `### ${session.title || "Current session"}`,
    "",
    `- **Session ID**: \`${session.sessionId}\``,
    `- **Status**: ${session.status}`,
    `- **Created**: ${formatSecond(session.createdAt)}`,
    `- **Updated**: ${formatSecond(session.updatedAt)}`,
    `- **Closed**: ${formatSecond(session.closedAt)}`,
    "",
  );
  const messages = session.messages ?? session.userPrompts.map((prompt, index) => ({ id: `legacy-${index + 1}`, role: "user" as const, content: prompt.content, createdAt: prompt.createdAt, attachments: [] }));
  if (!messages.length) {
    lines.push("_No messages recorded._", "");
    return;
  }
  for (const message of messages) {
    lines.push(`#### ${message.role === "user" ? "User prompt" : "Agent result"} · ${formatSecond(message.createdAt)}`, "", quote(message.content, "No visible content recorded."), "");
    if (message.attachments.length) lines.push("Attachments:", "", ...message.attachments.map((attachment) => renderAttachment(attachment, archive)), "");
  }
}

function renderRun(lines: string[], run: EvaluationRun, index: number, archive: boolean) {
  const sequence = run.sequence ?? index + 1;
  const validations = run.validations?.length ? run.validations : [run.build, run.qemu].filter((value): value is EvaluationValidation => Boolean(value));
  lines.push(
    `### Run ${sequence}`,
    "",
    `- **Run ID**: \`${run.id}\``,
    `- **Session ID**: \`${run.sessionId ?? "not recorded"}\``,
    `- **Time**: ${formatSecond(run.startedAt ?? run.createdAt)}`,
    `- **Model**: ${run.modelName ?? "not recorded"}`,
    `- **Status**: ${run.status}`,
    "",
    "#### User Prompt",
    "",
    quote(run.prompt, "No prompt recorded."),
    "",
    ...(run.attachments?.length ? ["Attachments:", "", ...run.attachments.map((attachment) => renderAttachment(attachment, archive)), ""] : []),
    "#### Agent Result",
    "",
    quote(run.finalAnswer || run.errorMessage, "No final result recorded."),
    "",
    "#### Validation",
    "",
    ...(validations.length ? validations.map(renderValidation) : ["- Build: not run", "- QEMU: not run"]),
    "",
    `- **Tools used**: ${run.tools.length ? run.tools.join(", ") : "none recorded"}`,
    `- **Retries**: ${run.retries}`,
    `- **Compactions**: ${run.compactions}`,
    `- **Finished**: ${formatSecond(run.finishedAt)}`,
    "",
  );
  for (const validation of validations) {
    if (validation.summary) lines.push(`##### ${(validation.kind ?? "validation").toUpperCase()} evidence`, "", quote(validation.summary, "No evidence recorded."), "");
  }
}

export function renderEvaluationHistory(snapshot: EvaluationHistorySnapshot, options: { archive?: boolean } = {}) {
  const currentSession = snapshot.conversations.find((conversation) => conversation.sessionId === snapshot.currentSessionId) ?? snapshot.conversations[0];
  const lines = [
    MANAGED_MARKER,
    "# Student Coursework Evaluation History",
    "",
    "This file is maintained by Courseworks. Hidden reasoning and raw tool output are intentionally excluded.",
    "",
    "## Course Information",
    "",
  ];
  const course = snapshot.courseInformation;
  if (course) {
    lines.push(`- **Course ID**: \`${course.courseId}\``, `- **Course**: ${course.courseTitle}`, `- **Coursework**: ${course.courseworkTitle}`, `- **Coursework version**: ${course.courseworkVersion ?? "not recorded"}`, `- **Semester**: ${course.semester ?? "not recorded"}`, `- **Class**: ${course.className ?? "not recorded"}`, `- **Specification SHA-256**: ${course.specificationSha256 ?? "not recorded"}`, `- **Initialized at**: ${formatSecond(course.initializedAt)}`, "");
  } else lines.push("- Course context: not initialized", "");

  lines.push("## Student and Workspace", "", `- **Student user ID**: ${snapshot.studentUserId ?? "not recorded"}`, `- **Student**: ${snapshot.studentEmail}`, `- **Workspace**: ${snapshot.workspaceUuid}`, `- **Workspace status**: ${snapshot.workspaceStatus}`, `- **Workspace last updated**: ${formatSecond(snapshot.workspaceUpdatedAt)}`, `- **Generated at**: ${formatSecond(snapshot.generatedAt)}`, "", "## Current Session", "");
  if (currentSession) {
    lines.push("## Conversation History", "");
    renderConversation(lines, currentSession, Boolean(options.archive));
  }
    else lines.push("_No active session._", "", "## Conversation History", "", "_No messages recorded._", "");

  lines.push("## Agent Run Records", "", "Each run records the complete user prompt and the final visible Agent result.", "");
  if (snapshot.runs.length) snapshot.runs.forEach((run, index) => renderRun(lines, run, index, Boolean(options.archive)));
  else lines.push("_No Agent Runs._", "");

  lines.push("## Validation Results", "");
  const allValidations = snapshot.validations?.length ? snapshot.validations : snapshot.runs.flatMap((run) => run.validations ?? [run.build, run.qemu].filter((value): value is EvaluationValidation => Boolean(value)));
  if (allValidations.length) lines.push(...allValidations.map(renderValidation), "");
  else lines.push("_No validation attempts recorded._", "");

  lines.push("## Coursework Overview", "");
  if (!snapshot.courseTasks.length) lines.push("_No course task records._", "");
  for (const [index, task] of snapshot.courseTasks.entries()) {
    lines.push(`### ${index + 1}. ${task.title}`, "", `- **Status**: ${task.status}`, `- **Created**: ${formatSecond(task.createdAt)}`, `- **Updated**: ${formatSecond(task.updatedAt)}`);
    if (task.summary) lines.push("", "#### Maintained Summary", "", quote(task.summary, "No summary."));
    lines.push("", "#### Subtasks", "");
    if (!task.subtasks.length) lines.push("_No subtasks recorded._");
    for (const subtask of task.subtasks) lines.push(`- **${subtask.title}**: ${subtask.status}`, `  - Goal: ${oneLine(subtask.goal)}`, `  - Validation: ${oneLine(subtask.validation)}`, `  - Build: ${subtask.buildStatus ?? "not recorded"}`, `  - QEMU: ${subtask.qemuStatus ?? "not recorded"}`, `  - Files: ${subtask.files.length ? subtask.files.map((file) => `\`${file}\``).join(", ") : "none recorded"}`);
    lines.push("");
  }

  lines.push("## Checkpoints", "");
  if (!snapshot.checkpoints.length) lines.push("_No checkpoints._", "");
  for (const checkpoint of snapshot.checkpoints) lines.push(`- **${checkpoint.label}** (\`${checkpoint.id}\`): ${checkpoint.status}; created ${formatSecond(checkpoint.createdAt)}; restored ${formatSecond(checkpoint.restoredAt)}`);
  lines.push("");

  lines.push("## Past Sessions", "");
  if (!snapshot.pastSessions?.length) lines.push("_No archived sessions._", "");
  for (const session of snapshot.pastSessions ?? []) lines.push(`- [${session.fileName}](past_sessions/${session.fileName}) - session \`${session.sessionId}\`, archived ${formatSecond(session.archivedAt)}${session.reason ? ` (${session.reason})` : ""}${session.runCount === undefined ? "" : `, ${session.runCount} runs`}${session.validationSummary ? `, validation ${session.validationSummary}` : ""}`);
  lines.push("");

  lines.push("## File Changes", "");
  if (!snapshot.activityEvents?.length) lines.push("_No recorded file changes._", "");
  for (const event of snapshot.activityEvents ?? []) lines.push(`- ${formatSecond(event.createdAt)} - **${event.eventType}** \`${event.path ?? "."}\`${event.runId ? ` (run \`${event.runId}\`)` : ""}${event.beforeSha256 ? `, before \`${event.beforeSha256}\`` : ""}${event.afterSha256 ? `, after \`${event.afterSha256}\`` : ""}`);

  if (snapshot.archivedAt) {
    lines.push("## Archive Metadata", "", `- **Archived at**: ${formatSecond(snapshot.archivedAt)}`, `- **Reason**: ${snapshot.archiveReason ?? "not recorded"}`, "", "## Workspace File Snapshot", "");
    if (!snapshot.workspaceFiles?.length) lines.push("_No workspace files recorded._", "");
    else lines.push(...snapshot.workspaceFiles.map((file) => `- \`${file.path}\` (${file.sizeBytes} bytes, sha256 \`${file.sha256}\`)`), "");
  }
  return lines.join("\n");
}

async function preserveLegacyHistory(filePath: string) {
  let existing: string;
  try {
    existing = await fs.readFile(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  if (!existing.trim() || existing.includes(MANAGED_MARKER)) return;
  const extension = path.extname(filePath);
  const base = filePath.slice(0, -extension.length);
  let legacyPath = `${base}.legacy${extension}`;
  try {
    await fs.access(legacyPath);
    legacyPath = `${base}.legacy-${Date.now()}${extension}`;
  } catch {
    // 保留已有历史文件，不覆盖用户内容。
  }
  await fs.rename(filePath, legacyPath);
}

export async function writeEvaluationHistorySnapshot(workspacePath: string, snapshot: EvaluationHistorySnapshot) {
  const root = evaluationHistoryRoot(workspacePath);
  await ensureEvaluationHistory(workspacePath);
  const filePath = evaluationHistoryFilePath(workspacePath);
  await preserveLegacyHistory(filePath);
  const temporaryPath = path.join(root, `.${HISTORY_FILE}.${process.pid}.${randomUUID()}.tmp`);
  const serialized = `${renderEvaluationHistory(snapshot)}\n`;
  const previousSize = await fs.stat(filePath).then((stat) => stat.size).catch(() => 0);
  await assertWorkspaceWriteAllowed(workspacePath, Math.max(0, Buffer.byteLength(serialized) - previousSize));
  try {
    await fs.writeFile(temporaryPath, serialized, { encoding: "utf8", mode: 0o600 });
    await fs.rename(temporaryPath, filePath);
    await fs.chmod(filePath, 0o600);
  } finally {
    await fs.rm(temporaryPath, { force: true }).catch(() => undefined);
  }
  return filePath;
}

async function loadCourseInformation(workspace: { id: string; user: { inviteCode?: { className: string | null } | null } }, taskTitle: string) {
  const existing = await prisma.evaluationCourseContext.findUnique({ where: { workspaceId: workspace.id } });
  if (existing) return { courseId: existing.courseId, courseTitle: existing.courseTitle, courseworkTitle: existing.courseworkTitle, courseworkVersion: existing.courseworkVersion ?? undefined, semester: existing.semester ?? undefined, className: existing.className ?? undefined, specificationSha256: existing.specificationSha256 ?? undefined, initializedAt: existing.initializedAt.toISOString() } satisfies EvaluationCourseInformation;
  let created;
  try {
    created = await prisma.evaluationCourseContext.create({ data: { workspaceId: workspace.id, courseId: DEFAULT_COURSE_ID, courseTitle: "Operating Systems", courseworkTitle: taskTitle || "Operating Systems Coursework", courseworkVersion: "v3", className: workspace.user.inviteCode?.className ?? undefined } });
  } catch (error) {
    if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== "P2002") throw error;
    created = await prisma.evaluationCourseContext.findUniqueOrThrow({ where: { workspaceId: workspace.id } });
  }
  return { courseId: created.courseId, courseTitle: created.courseTitle, courseworkTitle: created.courseworkTitle, courseworkVersion: created.courseworkVersion ?? undefined, semester: created.semester ?? undefined, className: created.className ?? undefined, specificationSha256: created.specificationSha256 ?? undefined, initializedAt: created.initializedAt.toISOString() } satisfies EvaluationCourseInformation;
}

async function listPastSessionArchives(workspacePath: string) {
  const root = pastSessionsRoot(workspacePath);
  await fs.mkdir(root, { recursive: true, mode: 0o700 });
  const result: EvaluationPastSession[] = [];
  for (const entry of await fs.readdir(root, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
    const content = await fs.readFile(path.join(root, entry.name), "utf8");
    const sessionId = content.match(/- \*\*Session ID\*\*: `([^`]+)`/)?.[1];
    const archivedAt = content.match(/- \*\*Archived at\*\*: ([^\n]+)/)?.[1];
    if (sessionId && archivedAt) result.push({ fileName: entry.name, sessionId, archivedAt, reason: content.match(/- \*\*Reason\*\*: ([^\n]+)/)?.[1], runCount: (content.match(/^### Run /gm) ?? []).length, validationSummary: content.match(/- \*\*(?:BUILD|QEMU)\*\*: (passed|failed|not run)/)?.[1] });
  }
  return result.sort((left, right) => left.archivedAt.localeCompare(right.archivedAt));
}

/** Keep exactly one archived session Markdown file: the session superseded by this /new. */
export async function retainLatestPastSessionArchive(
  workspacePath: string,
  retainedSessionId: string,
) {
  const root = pastSessionsRoot(workspacePath);
  await fs.mkdir(root, { recursive: true, mode: 0o700 });
  const safeSessionId = retainedSessionId.replace(/[^A-Za-z0-9_-]/g, "-");
  let removedFiles = 0;
  for (const entry of await fs.readdir(root, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
    if (entry.name.endsWith(`_${safeSessionId}.md`)) continue;
    await fs.rm(path.join(root, entry.name), { force: true });
    removedFiles += 1;
  }
  return { removedFiles };
}

async function snapshotWorkspaceFiles(workspacePath: string) {
  const result: WorkspaceFileSnapshot[] = [];
  async function walk(directory: string, relativeDirectory: string) {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      if (entry.name === ".git" || entry.name === ".courseworks") continue;
      const relativePath = path.join(relativeDirectory, entry.name);
      const absolutePath = path.join(directory, entry.name);
      if (entry.isDirectory()) await walk(absolutePath, relativePath);
      else if (entry.isFile()) {
        const bytes = await fs.readFile(absolutePath);
        result.push({ path: relativePath.split(path.sep).join("/"), sizeBytes: bytes.byteLength, sha256: createHash("sha256").update(bytes).digest("hex") });
      }
    }
  }
  await walk(workspacePath, "");
  return result.sort((left, right) => left.path.localeCompare(right.path));
}

async function collectEvaluationHistory(args: { workspacePath: string; userId: string; sessionId?: string }): Promise<EvaluationHistorySnapshot> {
  const workspace = await prisma.workspace.findFirst({ where: { userId: args.userId, path: args.workspacePath }, select: { id: true, workspaceUuid: true, status: true, updatedAt: true, user: { select: { email: true, inviteCode: { select: { className: true } } } } } });
  if (!workspace) throw new Error("Workspace was not found while refreshing evaluation history.");
  const [courseTasks, checkpoints, sessionListing] = await Promise.all([
    prisma.courseTaskSession.findMany({ where: { userId: args.userId, workspaceId: workspace.id }, orderBy: { createdAt: "asc" }, select: { title: true, status: true, summaryMarkdown: true, createdAt: true, updatedAt: true, subtasks: { orderBy: { createdAt: "asc" }, select: { title: true, status: true, goalMarkdown: true, latestUserIntent: true, lastValidationSummary: true, lastBuildStatus: true, lastQemuStatus: true, files: { where: { kind: "modified" }, orderBy: { updatedAt: "asc" }, select: { path: true } } } } } }),
    prisma.checkpoint.findMany({ where: { workspaceId: workspace.id }, orderBy: { createdAt: "asc" }, select: { id: true, label: true, status: true, createdAt: true, restoredAt: true } }),
    listChatSessions(args.workspacePath, { userId: args.userId, workspaceId: workspace.id }),
  ]);
  const currentSessionId = args.sessionId ?? sessionListing.currentSessionId ?? undefined;
  const currentSession = currentSessionId ? sessionListing.sessions.find((session) => session.sessionId === currentSessionId) : undefined;
  const messages = currentSession ? keepFinalVisibleMessages(await readChatSessionHistory(args.workspacePath, currentSession.sessionId, 2_000)) : [];
  const artifacts = currentSession ? await listConsumedArtifactsForSession(args.workspacePath, currentSession.sessionId) : [];
  const attachmentsByRun = new Map<string, EvaluationAttachment[]>();
  for (const artifact of artifacts) {
    if (!artifact.runId) continue;
    const attachment: EvaluationAttachment = {
      id: artifact.id,
      originalName: artifact.originalName,
      mimeType: artifact.mimeType,
      sizeBytes: artifact.sizeBytes,
      sha256: artifact.sha256,
      relativePath: artifact.storedName,
      archived: path.resolve(artifact.artifactPath).startsWith(`${path.resolve(artifactEvaluationHistoryRoot(args.workspacePath))}${path.sep}`),
      runId: artifact.runId,
    };
    attachmentsByRun.set(artifact.runId, [...(attachmentsByRun.get(artifact.runId) ?? []), attachment]);
  }
  // 主文件严格只显示当前 session；归档旧 session 时额外带上没有 sessionId 的历史 Run，避免升级前数据丢失。
  const runSessionFilter = args.sessionId && currentSessionId
    ? { OR: [{ sessionId: currentSessionId }, { sessionId: null }] }
    : currentSessionId
      ? { sessionId: currentSessionId }
      : { sessionId: null };
  const [runs, activityEvents] = await Promise.all([
    prisma.agentRun.findMany({ where: { workspaceId: workspace.id, ...runSessionFilter }, orderBy: [{ runSequence: "asc" }, { createdAt: "asc" }], select: { id: true, sessionId: true, runSequence: true, modelName: true, status: true, prompt: true, finalAnswerMarkdown: true, responseMarkdown: true, errorMessage: true, startedAt: true, createdAt: true, finishedAt: true, traceEvents: { orderBy: { createdAt: "asc" }, select: { stepName: true, stepStatus: true } }, buildRuns: { orderBy: { createdAt: "asc" }, select: { status: true, command: true, exitCode: true, logSummaryMarkdown: true, createdAt: true } }, qemuSmokeRuns: { orderBy: { createdAt: "asc" }, select: { status: true, command: true, exitCode: true, outputSummaryMarkdown: true, createdAt: true } } } }),
    prisma.workspaceActivityEvent.findMany({ where: { workspaceId: workspace.id, ...(currentSessionId ? { OR: [{ sessionId: currentSessionId }, { sessionId: null }] } : { sessionId: null }) }, orderBy: { createdAt: "asc" }, select: { id: true, eventType: true, path: true, actorUserId: true, sessionId: true, agentRunId: true, beforeSha256: true, afterSha256: true, createdAt: true } }),
  ]);
  const mappedRuns: EvaluationRun[] = runs.map((run, index) => {
    const tools = [...new Set(run.traceEvents.filter((trace) => trace.stepStatus === "success").map((trace) => evaluationToolName(trace.stepName)).filter((name): name is string => Boolean(name)))];
    const build = run.buildRuns.map((value) => ({ kind: "build" as const, status: value.status, command: value.command, exitCode: optionalNumber(value.exitCode), summary: value.logSummaryMarkdown ?? undefined, createdAt: value.createdAt.toISOString() }));
    const qemu = run.qemuSmokeRuns.map((value) => ({ kind: "qemu" as const, status: value.status, command: value.command, exitCode: optionalNumber(value.exitCode), summary: value.outputSummaryMarkdown ?? undefined, createdAt: value.createdAt.toISOString() }));
    return { id: run.id, sessionId: run.sessionId ?? undefined, sequence: run.runSequence ?? index + 1, modelName: run.modelName ?? undefined, status: run.status, prompt: run.prompt, finalAnswer: run.finalAnswerMarkdown ?? run.responseMarkdown ?? "", errorMessage: run.errorMessage ?? undefined, createdAt: run.createdAt.toISOString(), startedAt: run.startedAt.toISOString(), finishedAt: run.finishedAt?.toISOString(), tools, retries: new Set(run.traceEvents.filter((trace) => trace.stepName.startsWith("pi:retry:")).map((trace) => trace.stepName)).size, compactions: new Set(run.traceEvents.filter((trace) => trace.stepName.startsWith("pi:compaction:")).map((trace) => trace.stepName)).size, validations: [...build, ...qemu], build: build.at(-1), qemu: qemu.at(-1), attachments: attachmentsByRun.get(run.id) ?? [] };
  });
  const conversation: EvaluationConversation | undefined = currentSession ? { sessionId: currentSession.sessionId, title: currentSession.title, status: currentSession.status, createdAt: currentSession.createdAt, updatedAt: currentSession.updatedAt, closedAt: currentSession.closedAt, messages: messages.map((message: ChatHistoryMessage) => ({ id: message.id, role: message.role, content: message.content, createdAt: message.createdAt, runId: message.runId, attachments: message.runId ? (attachmentsByRun.get(message.runId) ?? []) : [] })), userPrompts: messages.filter((message) => message.role === "user").map((message) => ({ content: message.content, createdAt: message.createdAt })), assistantMessages: messages.filter((message) => message.role === "assistant").length } : undefined;
  const courseInformation = await loadCourseInformation(workspace, courseTasks[0]?.title ?? "Operating Systems Coursework");
  return { generatedAt: new Date().toISOString(), studentUserId: args.userId, studentEmail: workspace.user.email, workspaceUuid: workspace.workspaceUuid, workspaceStatus: workspace.status, workspaceUpdatedAt: workspace.updatedAt.toISOString(), courseInformation, currentSessionId, conversations: conversation ? [conversation] : [], runs: mappedRuns, validations: mappedRuns.flatMap((run) => run.validations ?? []), activityEvents: activityEvents.map((event) => ({ id: event.id, eventType: event.eventType, path: event.path ?? undefined, actorUserId: event.actorUserId ?? undefined, sessionId: event.sessionId ?? undefined, runId: event.agentRunId ?? undefined, beforeSha256: event.beforeSha256 ?? undefined, afterSha256: event.afterSha256 ?? undefined, createdAt: event.createdAt.toISOString() })), courseTasks: courseTasks.map((task) => ({ title: task.title, status: task.status, summary: task.summaryMarkdown ?? undefined, createdAt: task.createdAt.toISOString(), updatedAt: task.updatedAt.toISOString(), subtasks: task.subtasks.map((subtask) => ({ title: subtask.title, status: subtask.status, goal: subtask.goalMarkdown ?? subtask.latestUserIntent ?? undefined, validation: subtask.lastValidationSummary ?? undefined, buildStatus: subtask.lastBuildStatus ?? undefined, qemuStatus: subtask.lastQemuStatus ?? undefined, files: subtask.files.map((file) => file.path) })) })), checkpoints: checkpoints.map((checkpoint) => ({ id: checkpoint.id, label: checkpoint.label, status: checkpoint.status, createdAt: checkpoint.createdAt.toISOString(), restoredAt: checkpoint.restoredAt?.toISOString() })), pastSessions: await listPastSessionArchives(args.workspacePath) };
}

export async function archiveActiveEvaluationSession(args: { workspacePath: string; userId: string; session: StudentSession; reason: string }) {
  const root = pastSessionsRoot(args.workspacePath);
  await fs.mkdir(root, { recursive: true, mode: 0o700 });
  const safeSessionId = args.session.sessionId.replace(/[^A-Za-z0-9_-]/g, "-");
  const existing = (await fs.readdir(root)).find((fileName) => fileName.endsWith(`_${safeSessionId}.md`));
  if (existing) return path.join(root, existing);
  const snapshot = await collectEvaluationHistory({ workspacePath: args.workspacePath, userId: args.userId, sessionId: args.session.sessionId });
  const archivedAt = new Date().toISOString();
  const archivedSnapshot: EvaluationHistorySnapshot = { ...snapshot, archivedAt, archiveReason: args.reason, workspaceFiles: await snapshotWorkspaceFiles(args.workspacePath) };
  const archiveTimestamp = archivedAt.replace(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2}).*$/, "$1$2$3-$4$5$6");
  const fileName = `${archiveTimestamp}_${safeSessionId}.md`;
  const filePath = path.join(root, fileName);
  const temporaryPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporaryPath, `${renderEvaluationHistory(archivedSnapshot, { archive: true })}\n`, { encoding: "utf8", mode: 0o600 });
    await fs.rename(temporaryPath, filePath);
    await fs.chmod(filePath, 0o600);
  } finally {
    await fs.rm(temporaryPath, { force: true }).catch(() => undefined);
  }
  return filePath;
}

async function refreshNow(args: { workspacePath: string; userId: string }): Promise<EvaluationHistoryRefreshResult> {
  const snapshot = await collectEvaluationHistory(args);
  const filePath = await writeEvaluationHistorySnapshot(args.workspacePath, snapshot);
  return { filePath, runCount: snapshot.runs.length, conversationCount: snapshot.conversations.length };
}

export async function refreshEvaluationHistory(args: { workspacePath: string; userId: string }) {
  const key = path.resolve(args.workspacePath);
  const previous = refreshQueues.get(key);
  const current = (previous ? previous.catch(() => undefined) : Promise.resolve()).then(() => refreshNow(args));
  refreshQueues.set(key, current);
  try {
    return await current;
  } finally {
    if (refreshQueues.get(key) === current) refreshQueues.delete(key);
  }
}
