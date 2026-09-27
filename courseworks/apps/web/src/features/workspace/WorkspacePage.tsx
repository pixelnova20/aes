/**
 * 文件作用：实现前端“工作台”功能模块的 React 界面与交互。
 * 模块位置：`apps/web/src/features/workspace/WorkspacePage.tsx`，属于前端“工作台”功能模块。
 * 重要函数：`WorkspacePage()` 负责渲染并协调文件树、Monaco、AI 聊天和工作区状态。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ClipboardEvent as ReactClipboardEvent } from "react";
import type { editor } from "monaco-editor";

import { apiFetch } from "../../shared/api/client";
import { useAuth } from "../auth/auth-context";
import type { FileNode, Workspace } from "../../shared/types";
import { buildAgentRunActivity } from "./agent-run-activity";
import { AssistantPanel } from "./AssistantPanel";
import { REASONING_EFFORT_LABELS, WorkspaceImportDialog } from "./WorkspaceDialogs";
import { WorkspaceSidebar } from "./WorkspaceSidebar";
import { WorkspaceEditor } from "./WorkspaceEditor";
import { ActivityButton, Icon } from "./workspace-icons";
import type {
  AgentContextUsage,
  AiSettingsView,
  AgentRunView,
  ChatArtifactDownload,
  ChatEntry,
  ChatSessionSnapshot,
  ClassProgressView,
  CourseTaskView,
  OpenFile,
  StagedUpload,
  ViewKey,
  WorkbenchTheme,
  WorkspaceImportSummary,
} from "./workspace-types";
import {
  assistantEntryForRun,
  collapseAgentRunHistory,
  filesFromClipboardData,
  filterAgentRunsForChatSession,
  isTerminalRun,
  prefersChinese,
  readFileAsBase64,
  restoredRunStatus,
} from "./workspace-utils";

function useLatestCallback<Args extends unknown[], Result>(
  callback: (...args: Args) => Result,
): (...args: Args) => Result {
  const callbackRef = useRef(callback);
  callbackRef.current = callback;
  return useCallback((...args: Args) => callbackRef.current(...args), []);
}

/**
 * 功能：渲染并协调文件树、Monaco、AI 聊天和工作区状态。
 * 输入：无显式输入参数。
 * 输出：返回 React 元素，供父组件渲染。
 * 调用关系：由 React 组件树或路由渲染过程调用；内部调用 `useAuth()`、`useState()`、`getItem()`、`useRef()`、`useEffect()`、`then()`。
 */
export function WorkspacePage({ reviewMode = false }: { reviewMode?: boolean }) {
  // 这个页面是学生/教师主工作台：
  // 文件浏览、编辑、Agent 交互、工作区导入导出、AI 设置都在这里聚合。
  const { token, user, logout, refreshUser } = useAuth();
  const [workspace, setWorkspace] = useState<Workspace | null>(null);
  const [tree, setTree] = useState<FileNode[]>([]);
  const [openFiles, setOpenFiles] = useState<OpenFile[]>([]);
  const [activeFile, setActiveFile] = useState<string | null>(null);
  const [activeView, setActiveView] = useState<ViewKey>("explorer");
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [panelOpen, setPanelOpen] = useState(true);
  const [appMenuOpen, setAppMenuOpen] = useState(false);
  const [workbenchTheme, setWorkbenchTheme] = useState<WorkbenchTheme>(() =>
    window.localStorage.getItem("courseworks-workbench-theme") === "light" ? "light" : "dark"
  );
  const [createEntry, setCreateEntry] = useState<"file" | "directory" | null>(null);
  const [createPath, setCreatePath] = useState("");
  const [sidebarWidth, setSidebarWidth] = useState(245);
  const [assistantWidth, setAssistantWidth] = useState(420);
  const [promptHistory, setPromptHistory] = useState<string[]>([]);
  const [chatHistory, setChatHistory] = useState<ChatEntry[]>([]);
  const [collapsedDirectories, setCollapsedDirectories] = useState<Set<string>>(() => new Set());
  const [agentRuns, setAgentRuns] = useState<AgentRunView[]>([]);
  const [currentRun, setCurrentRun] = useState<AgentRunView | null>(null);
  const [latestRun, setLatestRun] = useState<AgentRunView | null>(null);
  const [agentBusy, setAgentBusy] = useState(false);
  const [stoppingAgent, setStoppingAgent] = useState(false);
  const [agentUsesChinese, setAgentUsesChinese] = useState(true);
  const [agentActivity, setAgentActivity] = useState("就绪");
  const [aiSettings, setAiSettings] = useState<AiSettingsView>({ configured: false });
  const [classProgress, setClassProgress] = useState<ClassProgressView | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [resettingAiContext, setResettingAiContext] = useState(false);
  const [uploadingFile, setUploadingFile] = useState(false);
  const [stagedUploads, setStagedUploads] = useState<StagedUpload[]>([]);
  const [courseTask, setCourseTask] = useState<CourseTaskView | null>(null);
  const [chatSession, setChatSession] = useState<ChatSessionSnapshot | null>(null);
  const [workspaceImportOpen, setWorkspaceImportOpen] = useState(false);
  const [workspaceImporting, setWorkspaceImporting] = useState(false);
  const [workspaceImportFile, setWorkspaceImportFile] = useState<File | null>(null);
  const [workspaceImportMode, setWorkspaceImportMode] = useState<"archive-only" | "extract">("extract");
  const [workspaceImportTargetPath, setWorkspaceImportTargetPath] = useState("");
  const [workspaceImportOverwritePolicy, setWorkspaceImportOverwritePolicy] = useState<"fail" | "merge" | "overwrite">("fail");
  const [workspaceImportSummary, setWorkspaceImportSummary] = useState<WorkspaceImportSummary | null>(null);
  const [workspaceImportError, setWorkspaceImportError] = useState<string | null>(null);
  const resizeRef = useRef<{ target: "sidebar" | "assistant"; startX: number; startWidth: number } | null>(null);
  const workspaceImportInputRef = useRef<HTMLInputElement | null>(null);
  const monacoEditorRef = useRef<editor.IStandaloneCodeEditor | null>(null);
  const uploadPreviewUrlsRef = useRef(new Map<string, string>());
  const historyPreviewUrlsRef = useRef(new Map<string, string>());
  const historyPreviewRequestRef = useRef(0);
  const visibleAgentRuns = useMemo(
    () => filterAgentRunsForChatSession(agentRuns, chatSession, chatHistory),
    [agentRuns, chatSession, chatHistory],
  );
  const agentMode = reviewMode ? "review" as const : "work" as const;
  const agentModeQuery = reviewMode ? "?mode=review" : "";

  useEffect(() => {
    // 进入工作台后一次性拉起主要状态。
    if (!token) return;
    void Promise.all([
      loadWorkspaceState(),
      loadAiSettings(),
      reviewMode ? Promise.resolve() : loadCourseTask(),
      !reviewMode && (user?.role === "teacher" || user?.role === "ta") ? loadClassProgress() : Promise.resolve()
    ]).then(([chatSnapshot]) => loadAgentRuns(chatSnapshot));
  }, [token, reviewMode]);

  useEffect(() => {
    return () => {
      for (const previewUrl of uploadPreviewUrlsRef.current.values()) {
        URL.revokeObjectURL(previewUrl);
      }
      uploadPreviewUrlsRef.current.clear();
      for (const previewUrl of historyPreviewUrlsRef.current.values()) {
        URL.revokeObjectURL(previewUrl);
      }
      historyPreviewUrlsRef.current.clear();
      historyPreviewRequestRef.current += 1;
    };
  }, []);

  useEffect(() => {
    window.localStorage.setItem("courseworks-workbench-theme", workbenchTheme);
  }, [workbenchTheme]);

  useEffect(() => {
    if (!agentBusy) {
      setAgentActivity("就绪");
      return;
    }
    const phases = ["思考中...", "正在读取工作区...", "正在分析任务...", "正在编写与检查..."];
    let index = 0;
    setAgentActivity(phases[index]);
    const timer = window.setInterval(() => {
      index = (index + 1) % phases.length;
      setAgentActivity(phases[index]);
    }, 1600);
    return () => window.clearInterval(timer);
  }, [agentBusy, agentUsesChinese]);

  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(null), 3500);
    return () => window.clearTimeout(timer);
  }, [notice]);

  useEffect(() => {
    /**
     * 功能：处理`on` `move`。
     * 输入：`event`（MouseEvent）提供event。
     * 输出：返回该操作的完成状态；同步处理无结果时返回 void，异步处理返回 Promise。
     * 调用关系：由本模块其他函数、应用编排层、协议适配层或测试按需调用；内部调用 `setSidebarWidth()`、`min()`、`max()`、`setAssistantWidth()`。
     */
    const onMove = (event: MouseEvent) => {
      const resize = resizeRef.current;
      if (!resize) return;
      if (resize.target === "sidebar") {
        setSidebarWidth(Math.min(420, Math.max(180, resize.startWidth + event.clientX - resize.startX)));
      } else {
        setAssistantWidth(Math.min(620, Math.max(280, resize.startWidth + resize.startX - event.clientX)));
      }
    };
    /**
     * 功能：处理`on` `up`。
     * 输入：无显式输入参数。
     * 输出：返回该操作的完成状态；同步处理无结果时返回 void，异步处理返回 Promise。
     * 调用关系：由本模块其他函数、应用编排层、协议适配层或测试按需调用。
     */
    const onUp = () => {
      resizeRef.current = null;
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, []);

  /**
   * 功能：加载工作区 `state`。
   * 输入：无显式输入参数。
   * 输出：返回该操作生成、查询或转换后的结果；异步实现以 Promise 交付结果。
   * 调用关系：由 `apps/web/src/features/workspace/WorkspacePage.tsx:WorkspacePage()` 调用；内部调用 `apiFetch()`、`setWorkspace()`、`all()`、`loadTree()`、`loadChatSession()`、`loadStagedUploads()`。
   */
  async function loadWorkspaceState(): Promise<ChatSessionSnapshot | null> {
    // 先拿 workspace 状态，再决定是否继续拉文件树和聊天状态。
    if (!token) return null;
    const data = await apiFetch<{ workspace: Workspace | { status: string } }>("/workspace/status", { token });
    const nextWorkspace = "id" in data.workspace ? data.workspace : null;
    setWorkspace(nextWorkspace);
    if (nextWorkspace?.status === "ready") {
      const [, chatSnapshot] = await Promise.all([
        reviewMode ? loadReviewAudit() : loadTree(),
        loadChatSession(),
        loadStagedUploads(),
      ]);
      return chatSnapshot;
    }
    return null;
  }

  /**
   * 功能：加载目录树。
   * 输入：无显式输入参数。
   * 输出：返回该操作生成、查询或转换后的结果；异步实现以 Promise 交付结果。
   * 调用关系：由 `apps/web/src/features/workspace/WorkspacePage.tsx:loadWorkspaceState()`、`apps/web/src/features/workspace/WorkspacePage.tsx:initializeWorkspace()`、`apps/web/src/features/workspace/WorkspacePage.tsx:createWorkspaceEntry()`、`apps/web/src/features/workspace/WorkspacePage.tsx:monitorAgentRun()`、`apps/web/src/features/workspace/WorkspacePage.tsx:importWorkspaceArchiveFromDialog()` 调用；内部调用 `apiFetch()`、`setTree()`。
   */
  async function loadTree() {
    if (!token) return;
    const data = await apiFetch<{ tree: FileNode[] }>("/workspace/tree", { token });
    setTree(data.tree);
  }

  async function loadReviewAudit() {
    if (!token || !reviewMode) return;
    try {
      const data = await apiFetch<{ tree: FileNode[] }>("/teacher/review/audit/tree", { token });
      setTree(data.tree);
    } catch (error) {
      setTree([]);
      setNotice(error instanceof Error ? error.message : "无法加载学生审核目录。");
    }
  }

  /**
   * 功能：加载`ai` 设置。
   * 输入：无显式输入参数。
   * 输出：返回该操作生成、查询或转换后的结果；异步实现以 Promise 交付结果。
   * 调用关系：由 `WorkspacePage()` 初始化流程调用；内部调用 `apiFetch()`、`setAiSettings()`。
   */
  async function loadAiSettings() {
    if (!token) return;
    const data = await apiFetch<{ settings: AiSettingsView }>("/ai/settings", { token });
    setAiSettings(data.settings);
  }

  /**
   * 功能：加载Agent 运行列表。
   * 输入：无显式输入参数。
   * 输出：返回该操作生成、查询或转换后的结果；异步实现以 Promise 交付结果。
   * 调用关系：由 `apps/web/src/features/workspace/WorkspacePage.tsx:WorkspacePage()` 调用；内部调用 `apiFetch()`、`setAgentRuns()`、`find()`、`isTerminalRun()`、`setAgentUsesChinese()`、`prefersChinese()`。
   */
  async function loadAgentRuns(chatSnapshot: ChatSessionSnapshot | null = chatSession) {
    // 如果页面刷新时还有未结束 run，这里会把前端状态接回去继续监控。
    if (!token) return;
    const data = await apiFetch<{ runs: AgentRunView[] }>("/agent/runs", { token });
    setAgentRuns(data.runs);
    const sessionRuns = filterAgentRunsForChatSession(data.runs, chatSnapshot);
    setLatestRun(sessionRuns[0] ?? null);
    const activeRun = sessionRuns.find((run) => !isTerminalRun(run));
    if (activeRun) {
      setAgentUsesChinese(prefersChinese(activeRun.prompt ?? ""));
      setAgentBusy(true);
      setChatHistory((history) => {
        const assistantId = `history-assistant-${activeRun.id}`;
        if (history.some((entry) => entry.id === assistantId)) return history;
        return [
          ...history.filter((entry) => !(entry.role === "assistant" && entry.runId === activeRun.id)),
          assistantEntryForRun(assistantId, activeRun),
        ];
      });
      void monitorAgentRun(activeRun.id, `history-assistant-${activeRun.id}`);
    }
    if (sessionRuns[0]) await loadAgentRun(sessionRuns[0].id);
  }

  /**
   * 功能：加载聊天 会话。
   * 输入：无显式输入参数。
   * 输出：返回该操作生成、查询或转换后的结果；异步实现以 Promise 交付结果。
   * 调用关系：由 `apps/web/src/features/workspace/WorkspacePage.tsx:loadWorkspaceState()` 调用；内部调用 `apiFetch()`、`setChatSession()`、`setPromptHistory()`、`setChatHistory()`、`prefersChinese()`。
   */
  async function loadChatSession(): Promise<ChatSessionSnapshot | null> {
    if (!token) return null;
    const data = await apiFetch<{ chat: ChatSessionSnapshot }>(`/agent/chat-sessions${agentModeQuery}`, { token });
    setChatSession(data.chat);
    setPromptHistory(data.chat.history
      .filter((entry) => entry.role === "user")
      .map((entry) => entry.content));
    const restoredHistory = collapseAgentRunHistory(data.chat.history).map((entry) => ({
      id: entry.id,
      role: entry.role,
      content: entry.content,
      runId: entry.runId,
      chinese: prefersChinese(entry.content),
      attachments: entry.attachments,
    }));
    setChatHistory(restoredHistory);
    void loadHistoryAttachmentPreviews(restoredHistory);
    return data.chat;
  }

  async function loadHistoryAttachmentPreviews(history: ChatEntry[]) {
    if (!token) return;
    const requestId = ++historyPreviewRequestRef.current;
    const imageAttachments = history.flatMap((entry) => entry.attachments ?? [])
      .filter((attachment) => attachment.mimeType.startsWith("image/"));
    await Promise.all(imageAttachments.map(async (attachment) => {
      if (historyPreviewUrlsRef.current.has(attachment.id)) return;
      try {
        const response = await fetch(
          `/api/agent/session-attachments/${encodeURIComponent(attachment.id)}/preview`,
          { headers: { Authorization: `Bearer ${token}` } },
        );
        if (!response.ok) return;
        const previewUrl = URL.createObjectURL(await response.blob());
        if (requestId !== historyPreviewRequestRef.current) {
          URL.revokeObjectURL(previewUrl);
          return;
        }
        historyPreviewUrlsRef.current.set(attachment.id, previewUrl);
      } catch {
        // Keep the attachment filename visible when its thumbnail cannot be loaded.
      }
    }));
    if (requestId !== historyPreviewRequestRef.current) return;
    setChatHistory((entries) => entries.map((entry) => ({
      ...entry,
      attachments: entry.attachments?.map((attachment) => ({
        ...attachment,
        previewUrl: historyPreviewUrlsRef.current.get(attachment.id),
      })),
    })));
  }

  /**
   * 功能：加载聊天 上下文 占用信息。
   * 输入：无显式输入参数。
   * 输出：返回该操作生成、查询或转换后的结果；异步实现以 Promise 交付结果。
   * 调用关系：由聊天提交和 Agent 运行监控流程调用；内部调用 `apiFetch()`、`setChatSession()`。
   */
  async function loadChatContextUsage() {
    if (!token) return;
    const data = await apiFetch<{ contextUsage: AgentContextUsage | null }>(
      `/agent/chat-sessions/context-usage${agentModeQuery}`,
      { token },
    );
    setChatSession((current) => current
      ? { ...current, contextUsage: data.contextUsage }
      : current);
  }

  /**
   * 功能：加载课程 课程任务。
   * 输入：无显式输入参数。
   * 输出：返回该操作生成、查询或转换后的结果；异步实现以 Promise 交付结果。
   * 调用关系：由 `apps/web/src/features/workspace/WorkspacePage.tsx:WorkspacePage()`、`apps/web/src/features/workspace/WorkspacePage.tsx:submitChat()`、`apps/web/src/features/workspace/WorkspacePage.tsx:monitorAgentRun()`、`apps/web/src/features/workspace/WorkspacePage.tsx:startNewChatSession()` 调用；内部调用 `apiFetch()`、`setCourseTask()`。
   */
  async function loadCourseTask() {
    if (!token) return;
    const data = await apiFetch<{ courseTask: CourseTaskView | null }>("/agent/course-task", { token });
    setCourseTask(data.courseTask);
  }

  /**
   * 功能：加载`staged` 上传附件列表。
   * 输入：无显式输入参数。
   * 输出：返回该操作生成、查询或转换后的结果；异步实现以 Promise 交付结果。
   * 调用关系：由 `apps/web/src/features/workspace/WorkspacePage.tsx:loadWorkspaceState()` 调用；内部调用 `apiFetch()`、`setStagedUploads()`。
   */
  async function loadStagedUploads() {
    if (!token) return;
    const data = await apiFetch<{ uploads: StagedUpload[] }>("/workspace/uploads", { token });
    setStagedUploads(data.uploads);
  }

  /**
   * 功能：加载Agent 运行。
   * 输入：`id`（string）提供id。 `options`（{ showInChat?: boolean }）提供options。
   * 输出：返回该操作生成、查询或转换后的结果；异步实现以 Promise 交付结果。
   * 调用关系：由 `apps/web/src/features/workspace/WorkspacePage.tsx:loadAgentRuns()`、`apps/web/src/features/workspace/WorkspacePage.tsx:monitorAgentRun()`、`apps/web/src/features/workspace/WorkspacePage.tsx:WorkspacePage()` 调用；内部调用 `apiFetch()`、`setCurrentRun()`、`setChatHistory()`、`prefersChinese()`、`assistantEntryForRun()`。
   */
  async function loadAgentRun(id: string, options: { showInChat?: boolean } = {}) {
    // 左侧历史 run 被点击时，把该 run 还原成一轮可读对话，便于学生查看最终回答和中间过程。
    if (!token) return;
    const data = await apiFetch<{ run: AgentRunView }>(`/agent/runs/${id}`, { token });
    setCurrentRun(data.run);
    setAgentRuns((runs) => runs.map((run) => run.id === data.run.id ? data.run : run));
    setLatestRun((latest) => latest?.id === data.run.id ? data.run : latest);
    if (options.showInChat) {
      const userId = `run-user-${data.run.id}`;
      const assistantId = `run-assistant-${data.run.id}`;
      setChatHistory([
        {
          id: userId,
          role: "user",
          content: data.run.prompt || data.run.taskSummary || "Agent 运行",
          chinese: prefersChinese(data.run.prompt || data.run.taskSummary || "")
        },
        assistantEntryForRun(assistantId, data.run)
      ]);
    }
  }

  /**
   * 功能：加载`class` `progress`。
   * 输入：无显式输入参数。
   * 输出：返回该操作生成、查询或转换后的结果；异步实现以 Promise 交付结果。
   * 调用关系：由 `apps/web/src/features/workspace/WorkspacePage.tsx:WorkspacePage()`、`apps/web/src/features/workspace/WorkspacePage.tsx:selectView()` 调用；内部调用 `apiFetch()`、`setClassProgress()`。
   */
  async function loadClassProgress() {
    if (!token || (user?.role !== "teacher" && user?.role !== "ta")) return;
    const data = await apiFetch<ClassProgressView>("/teacher/class-progress", { token });
    setClassProgress(data);
  }

  const currentFile = useMemo(
    () => openFiles.find((entry) => entry.path === activeFile) ?? null,
    [openFiles, activeFile]
  );
  const lastBuild = currentRun?.buildRuns?.[0];
  const runReady = Boolean(currentRun?.id && lastBuild?.status === "success");
  const handleCloseSidebar = useCallback(() => setSidebarOpen(false), []);
  const handleOpenAssistant = useCallback(() => setPanelOpen(true), []);
  const handleCloseAssistant = useCallback(() => setPanelOpen(false), []);
  const handleOpenFile = useLatestCallback((path: string) => void openFile(path));
  const handleOpenRun = useLatestCallback((runId: string) => void loadAgentRun(runId, { showInChat: true }));
  const handleCreateWorkspaceEntry = useLatestCallback((event: React.FormEvent) => void createWorkspaceEntry(event));
  const handleCloseFile = useLatestCallback((path: string) => closeFile(path));
  const handleUpdateCurrentFile = useLatestCallback((content: string | undefined) => updateCurrentFile(content));
  const handleStartNewChatSession = useLatestCallback(() => startNewChatSession());
  const handleToggleChatActivity = useLatestCallback((entry: ChatEntry) => void toggleChatActivity(entry));
  const handleDownloadChatArtifact = useLatestCallback((download: ChatArtifactDownload) => void downloadChatArtifact(download));
  const handleRemoveStagedUpload = useLatestCallback((uploadId: string) => void removeStagedUploadChip(uploadId));
  const handleSubmitChat = useLatestCallback((prompt: string) => void submitChat(prompt));
  const handleStopActiveAgent = useLatestCallback(() => void stopActiveAgent());
  const handleUploadConversationAttachments = useLatestCallback(
    (event: React.ChangeEvent<HTMLInputElement>) => void uploadConversationAttachments(event),
  );
  const handlePasteConversationAttachment = useLatestCallback(
    (event: ReactClipboardEvent<HTMLTextAreaElement>) => void pasteConversationFiles(event),
  );

  /**
   * 功能：切换聊天 活动记录。
   * 输入：`entry`（ChatEntry）提供entry。
   * 输出：返回该操作的完成状态；同步处理无结果时返回 void，异步处理返回 Promise。
   * 调用关系：由 `apps/web/src/features/workspace/WorkspacePage.tsx:WorkspacePage()` 调用；内部调用 `apiFetch()`、`restoredRunStatus()`、`buildAgentRunActivity()`、`setChatHistory()`。
   */
  async function toggleChatActivity(entry: ChatEntry) {
    if (entry.activity || !entry.runId || !token) return;
    try {
      const data = await apiFetch<{ run: AgentRunView }>(`/agent/runs/${entry.runId}`, { token });
      const output = data.run.finalAnswerMarkdown || data.run.responseMarkdown || restoredRunStatus(data.run);
      const activity = buildAgentRunActivity(data.run, output);
      setChatHistory((history) => history.map((candidate) => candidate.id === entry.id
        ? {
            ...candidate,
            activity: activity.length
              ? activity
              : "这个任务没有保存可展示的过程事件。"
          }
        : candidate));
    } catch (error) {
      setChatHistory((history) => history.map((candidate) => candidate.id === entry.id
        ? {
            ...candidate,
            activity: error instanceof Error
              ? error.message
              : "无法读取任务过程。"
          }
        : candidate));
    }
  }

  useEffect(() => {
    /**
     * 功能：处理`on` `key` `down`。
     * 输入：`event`（KeyboardEvent）提供event。
     * 输出：返回该操作的完成状态；同步处理无结果时返回 void，异步处理返回 Promise。
     * 调用关系：由本模块其他函数、应用编排层、协议适配层或测试按需调用；内部调用 `toLowerCase()`、`preventDefault()`、`saveCurrentFile()`。
     */
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
        event.preventDefault();
        void saveCurrentFile();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [token, currentFile]);

  /**
   * 功能：初始化工作区。
   * 输入：无显式输入参数。
   * 输出：返回该操作的完成状态；同步处理无结果时返回 void，异步处理返回 Promise。
   * 调用关系：由 `apps/web/src/features/workspace/WorkspacePage.tsx:WorkspacePage()` 调用；内部调用 `apiFetch()`、`setWorkspace()`、`refreshUser()`、`loadTree()`。
   */
  async function initializeWorkspace() {
    if (!token) return;
    const data = await apiFetch<{ workspace: Workspace }>("/workspace/initialize", { method: "POST", token });
    setWorkspace(data.workspace);
    await refreshUser();
    await loadTree();
  }

  /**
   * 功能：打开文件。
   * 输入：`path`（string）提供路径。
   * 输出：返回该操作生成、查询或转换后的结果；异步实现以 Promise 交付结果。
   * 调用关系：由 `apps/web/src/features/workspace/WorkspacePage.tsx:createWorkspaceEntry()`、`apps/web/src/features/workspace/WorkspacePage.tsx:WorkspacePage()` 调用；内部调用 `some()`、`setActiveFile()`、`apiFetch()`、`encodeURIComponent()`、`setOpenFiles()`。
   */
  async function openFile(path: string) {
    if (!token) return;
    if (openFiles.some((entry) => entry.path === path)) {
      setActiveFile(path);
      return;
    }
    const data = await apiFetch<{ path: string; content: string }>(
      reviewMode
        ? `/teacher/review/audit/file?path=${encodeURIComponent(path)}`
        : `/workspace/file?path=${encodeURIComponent(path)}`,
      { token }
    );
    setOpenFiles((files) => [...files, { path: data.path, content: data.content, dirty: false }]);
    setActiveFile(data.path);
  }

  /**
   * 功能：关闭文件。
   * 输入：`path`（string）提供路径。
   * 输出：返回该操作的完成状态；同步处理无结果时返回 void，异步处理返回 Promise。
   * 调用关系：由本模块其他函数、应用编排层、协议适配层或测试按需调用；内部调用 `setOpenFiles()`、`findIndex()`、`setActiveFile()`、`max()`。
   */
  function closeFile(path: string) {
    setOpenFiles((files) => {
      const index = files.findIndex((file) => file.path === path);
      const next = files.filter((file) => file.path !== path);
      if (activeFile === path) setActiveFile(next[Math.max(0, index - 1)]?.path ?? null);
      return next;
    });
  }

  /**
   * 功能：更新`current` 文件。
   * 输入：`content`（string | undefined）提供content。
   * 输出：返回该操作的完成状态；同步处理无结果时返回 void，异步处理返回 Promise。
   * 调用关系：由本模块其他函数、应用编排层、协议适配层或测试按需调用；内部调用 `setOpenFiles()`。
   */
  function updateCurrentFile(content: string | undefined) {
    if (reviewMode) return;
    if (!currentFile || content === undefined) return;
    setOpenFiles((files) =>
      files.map((file) => file.path === currentFile.path ? { ...file, content, dirty: true } : file)
    );
  }

  /**
   * 功能：保存`current` 文件。
   * 输入：无显式输入参数。
   * 输出：返回该操作的完成状态；同步处理无结果时返回 void，异步处理返回 Promise。
   * 调用关系：由 `apps/web/src/features/workspace/WorkspacePage.tsx:onKeyDown()` 调用；内部调用 `apiFetch()`、`stringify()`、`setOpenFiles()`、`setNotice()`。
   */
  async function saveCurrentFile() {
    // 编辑器里的 Ctrl/Cmd + S 最终落到这里。
    if (reviewMode || !token || !currentFile) return;
    await apiFetch("/workspace/file", {
      method: "PUT",
      token,
      body: JSON.stringify({ path: currentFile.path, content: currentFile.content })
    });
    setOpenFiles((files) =>
      files.map((file) => file.path === currentFile.path ? { ...file, dirty: false } : file)
    );
    setNotice(`已保存 ${currentFile.path}`);
  }

  /**
   * 功能：创建工作区 `entry`。
   * 输入：`event`（React.FormEvent）提供event。
   * 输出：返回该操作生成、查询或转换后的结果；异步实现以 Promise 交付结果。
   * 调用关系：由本模块其他函数、应用编排层、协议适配层或测试按需调用；内部调用 `preventDefault()`、`replace()`、`apiFetch()`、`stringify()`、`setCreateEntry()`、`setCreatePath()`。
   */
  async function createWorkspaceEntry(event: React.FormEvent) {
    event.preventDefault();
    if (!token || !createEntry || !createPath.trim()) return;
    const path = createPath.trim().replace(/^\/+/, "");
    try {
      if (createEntry === "file") {
        await apiFetch("/workspace/file", {
          method: "POST",
          token,
          body: JSON.stringify({ path, content: "" })
        });
      } else {
        await apiFetch("/workspace/directory", {
          method: "POST",
          token,
          body: JSON.stringify({ path })
        });
      }
      setCreateEntry(null);
      setCreatePath("");
      await loadTree();
      if (createEntry === "file") await openFile(path);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "无法创建工作区项目。");
    }
  }

  /**
   * 功能：上传`conversation` `attachments`。
   * 输入：`event`（React.ChangeEvent<HTMLInputElement>）提供event。
   * 输出：返回该操作生成、查询或转换后的结果；异步实现以 Promise 交付结果。
   * 调用关系：由 `apps/web/src/features/workspace/WorkspacePage.tsx:WorkspacePage()` 调用；内部调用 `from()`、`setUploadingFile()`、`all()`、`readFileAsBase64()`、`apiFetch()`、`stringify()`。
   */
  async function uploadConversationFiles(selected: File[]) {
    // 这里上传的是“会话附件暂存”，和工作区导入是两条不同的流程。
    if (!token || !selected.length) return;

    setUploadingFile(true);
    try {
      const files = await Promise.all(selected.map(async (file) => ({
        name: file.name,
        mimeType: file.type,
        contentBase64: await readFileAsBase64(file)
      })));
      const data = await apiFetch<{ uploads: StagedUpload[] }>("/workspace/uploads", {
        method: "POST",
        token,
        body: JSON.stringify({ files })
      });
      const nextUploads = data.uploads.map((upload) => {
        if (!uploadPreviewUrlsRef.current.has(upload.id)) {
          const source = selected.find((file) => file.name === upload.originalName && file.size === upload.size);
          if (source?.type.startsWith("image/")) {
            uploadPreviewUrlsRef.current.set(upload.id, URL.createObjectURL(source));
          }
        }
        return {
          ...upload,
          previewUrl: uploadPreviewUrlsRef.current.get(upload.id),
        };
      });
      setStagedUploads(nextUploads);
      setNotice(selected.length === 1
        ? `已添加 ${selected[0].name}`
        : `已添加 ${selected.length} 个文件`);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "无法上传文件。");
    } finally {
      setUploadingFile(false);
    }
  }

  async function uploadConversationAttachments(event: React.ChangeEvent<HTMLInputElement>) {
    const selected = Array.from(event.target.files ?? []);
    event.target.value = "";
    await uploadConversationFiles(selected);
  }

  async function readImagesFromClipboardApi(): Promise<File[]> {
    if (!navigator.clipboard?.read) return [];
    try {
      const clipboardItems = await navigator.clipboard.read();
      const imageFiles: File[] = [];
      for (const item of clipboardItems) {
        const imageType = item.types.find((type) => type.toLowerCase().startsWith("image/"));
        if (!imageType) continue;
        const blob = await item.getType(imageType);
        imageFiles.push(new File([blob], "clipboard-image", {
          type: imageType,
          lastModified: Date.now(),
        }));
      }
      return imageFiles;
    } catch {
      // Clipboard.read() requires browser permission and a secure context; paste event data may still work.
      return [];
    }
  }

  async function pasteConversationFiles(event: ReactClipboardEvent<HTMLTextAreaElement>) {
    const directFiles = filesFromClipboardData(event.clipboardData);
    const resolvedFiles = directFiles.length ? directFiles : await readImagesFromClipboardApi();
    if (!resolvedFiles.length) return;

    event.preventDefault();
    const stamp = new Date().toISOString().replace(/[-:TZ.]/g, "").slice(0, 14);
    const namedFiles = resolvedFiles.map((file, index) => {
      const isGeneratedClipboardImage = !file.name || file.name === "clipboard-image";
      const extension = file.type.toLowerCase().split("/")[1]?.replace("jpeg", "jpg") || "bin";
      const name = isGeneratedClipboardImage
        ? `pasted-image-${stamp}-${index + 1}.${extension}`
        : file.name;
      return new File([file], name, {
        type: file.type,
        lastModified: Date.now(),
      });
    });
    void uploadConversationFiles(namedFiles);
  }

  /**
   * 功能：移除`staged` 上传附件 `chip`。
   * 输入：`uploadId`（string）提供上传附件 id。
   * 输出：返回该操作的完成状态；同步处理无结果时返回 void，异步处理返回 Promise。
   * 调用关系：由 `apps/web/src/features/workspace/WorkspacePage.tsx:WorkspacePage()` 调用；内部调用 `apiFetch()`、`encodeURIComponent()`、`setStagedUploads()`、`setNotice()`。
   */
  async function removeStagedUploadChip(uploadId: string) {
    if (!token) return;
    try {
      await apiFetch(`/workspace/uploads/${encodeURIComponent(uploadId)}`, { method: "DELETE", token });
      const previewUrl = uploadPreviewUrlsRef.current.get(uploadId);
      if (previewUrl) {
        URL.revokeObjectURL(previewUrl);
        uploadPreviewUrlsRef.current.delete(uploadId);
      }
      setStagedUploads((uploads) => uploads.filter((upload) => upload.id !== uploadId));
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "无法移除暂存附件。");
    }
  }

  /**
   * 功能：处理提交 聊天。
   * 输入：`promptValue`（string）提供已在独立输入组件中整理好的用户输入。
   * 输出：返回该操作生成、查询或转换后的结果；异步实现以 Promise 交付结果。
   * 调用关系：由 `apps/web/src/features/workspace/AssistantPanel.tsx:ChatComposer()` 调用；内部调用 `toLowerCase()`、`startNewChatSession()`、`setPromptHistory()`、`setChatHistory()`、`now()`。
   */
  async function submitChat(promptValue: string) {
    // submitChat 通过后端命令分发（对齐 OpenClaw auto-reply dispatch）。
    // 后端先检查是否为斜杠命令：是则直接返回结果，否则启动 AI Agent。
    if (!token || !promptValue.trim() || agentBusy) return;
    const prompt = promptValue.trim();

    // /new：重置会话 + 清空工作区（客户端状态变化大，保持独立流程）
    if (prompt.toLowerCase() === "/new") {
      await startNewChatSession();
      return;
    }

    setPromptHistory((history) => [...history, prompt]);

    // /compact：压缩会话（需要专门的 API 端点）
    if (prompt.toLowerCase() === "/compact") {
      setChatHistory((h) => [...h,
        { id: `user-${Date.now()}`, role: "user", content: "/compact" },
        { id: `sys-${Date.now()}`, role: "assistant", content: "正在压缩会话..." }
      ]);
      try {
        const data = await apiFetch<{ compact: { compacted: boolean; beforeTurns: number; afterTurns: number; skipped: boolean; reason?: string; summaryText?: string } }>("/agent/chat-sessions/compact", {
          method: "POST",
          token,
          body: JSON.stringify({ mode: agentMode }),
        });
        const c = data.compact;
        const now = new Date().toLocaleTimeString();
        let content: string;
        if (c.compacted) {
          content = [
            `## \`/compact\` - 已完成`, "",
            `> ${c.beforeTurns} → ${c.afterTurns} 轮 | 查询时间 ${now}`, "",
            `**压缩结果：** ${c.beforeTurns} 轮减少到 ${c.afterTurns} 轮。`,
            `较早的会话内容已生成摘要，并将用于后续上下文。`,
            "",
            c.summaryText ? `### 摘要\n\n${c.summaryText.slice(0, 2000)}` : ""
          ].join("\n");
        } else {
          content = [
            `## \`/compact\` - 已跳过`, "",
            `> ${c.beforeTurns} 轮 | 查询时间 ${now}`, "",
            `**原因：** ${c.reason ?? "尚未达到阈值（至少需要 20 轮）。"}`,
            "",
            `会话超过 20 轮时才会触发压缩。当前轮数：${c.beforeTurns}。`
          ].join("\n");
        }
        setChatHistory((h) => h.slice(0, -1).concat({ id: `sys-${Date.now()}`, role: "assistant", content }));
      } catch (e) {
        setChatHistory((h) => h.slice(0, -1).concat({ id: `sys-${Date.now()}`, role: "assistant", content: "会话压缩失败。" }));
      } finally {
        void loadChatContextUsage();
      }
      return;
    }

    // /tools 和 /context：通过后端命令分发处理，返回 commandResult
    // 这些命令不需要 agent，直接在浏览器展示结果
    if (prompt.toLowerCase() === "/tools" || prompt.toLowerCase() === "/context") {
      setChatHistory((h) => [...h,
        { id: `user-${Date.now()}`, role: "user", content: prompt },
        { id: `sys-${Date.now()}`, role: "assistant", content: "..." }
      ]);
      try {
        const data = await apiFetch<{ command: { key: string; markdown: string; sideEffect?: string } }>("/agent/runs", {
          method: "POST",
          token,
          body: JSON.stringify({ prompt, mode: agentMode }),
        });
        setChatHistory((h) => h.slice(0, -1).concat({
          id: `sys-${Date.now()}`, role: "assistant", content: data.command.markdown
        }));
      } catch (e) {
        setChatHistory((h) => h.slice(0, -1).concat({
          id: `sys-${Date.now()}`, role: "assistant", content: "命令执行失败。"
        }));
      }
      return;
    }

    const assistantId = `assistant-${Date.now()}`;
    const usesChinese = prefersChinese(prompt);
    setAgentUsesChinese(usesChinese);
    setPanelOpen(true);
    setAgentBusy(true);
    const attachmentsForRun = stagedUploads.slice(0, 12);

    // 获取当前编辑器选中文本
    let selection: { filePath: string; text: string; startLine: number; endLine: number } | undefined;
    const ed = monacoEditorRef.current;
    if (ed && currentFile) {
      const sel = ed.getSelection();
      if (sel && !sel.isEmpty()) {
        const model = ed.getModel();
        if (model) {
          selection = {
            filePath: currentFile.path,
            text: model.getValueInRange(sel),
            startLine: sel.startLineNumber,
            endLine: sel.endLineNumber,
          };
        }
      }
    }

    // 构建聊天回显：prompt + 打开文件 + 选中行号；附件单独显示缩略图或文件名。
    const echoParts: string[] = [prompt];
    if (currentFile) {
      echoParts.push(`\n📂 ${currentFile.path}`);
    }
    if (selection) {
      const range = selection.startLine === selection.endLine
        ? `L${selection.startLine}`
        : `L${selection.startLine}-${selection.endLine}`;
      echoParts.push(`（已选择 ${range}）`);
    }
    const userDisplay = echoParts.join("");

    setChatHistory((history) => [
      ...history,
      {
        id: `user-${Date.now()}`,
        role: "user",
        content: userDisplay,
        chinese: usesChinese,
        attachments: attachmentsForRun.map((upload) => ({
          id: upload.id,
          originalName: upload.originalName,
          mimeType: upload.mimeType,
          sizeBytes: upload.size,
          previewUrl: upload.previewUrl,
        })),
      },
      {
        id: assistantId,
        role: "assistant",
        content: "正在处理工作区中的任务...",
        chinese: usesChinese,
        pending: true
      }
    ]);

    try {
      const data = await apiFetch<{ run: AgentRunView }>("/agent/runs", {
        method: "POST",
        token,
        body: JSON.stringify({
          prompt,
          mode: agentMode,
          openFiles: currentFile ? [currentFile.path] : [],
          attachmentIds: attachmentsForRun.map((upload) => upload.id),
          ...(selection ? { selection } : {}),
        })
      });
      setCurrentRun(data.run);
      setAgentRuns((runs) => [data.run, ...runs.filter((run) => run.id !== data.run.id)]);
      setLatestRun(data.run);
      setChatHistory((history) => history.map((entry) => entry.id === assistantId
        ? { ...entry, runId: data.run.id }
        : entry));
      setStagedUploads([]);
      // 这里只加载课程任务元数据。聊天历史由本地监控循环维护；若此处重新调用
      // loadChatSession()，原始 transcript 会覆盖整个 chatHistory，包括进行中的助手消息，
      // 从而破坏滚动位置，并可能在后端仍写入 transcript 时清除增量消息。
      // 同样跳过 loadStagedUploads()，防止后端索引尚未更新时让已清理附件重新出现。
      if (!reviewMode) await loadCourseTask();
      void monitorAgentRun(data.run.id, assistantId);
    } catch (error) {
      setChatHistory((history) =>
        history.map((entry) => entry.id === assistantId
          ? { ...entry, content: error instanceof Error ? error.message : "Agent request failed.", pending: false }
          : entry)
      );
      setAgentBusy(false);
      return;
    }
  }

  /**
   * 功能：监控Agent 运行。
   * 输入：`runId`（string）提供运行 id。 `assistantId`（string）提供助手消息 id。
   * 输出：返回该操作生成、查询或转换后的结果；异步实现以 Promise 交付结果。
   * 调用关系：由 `apps/web/src/features/workspace/WorkspacePage.tsx:loadAgentRuns()`、`apps/web/src/features/workspace/WorkspacePage.tsx:submitChat()` 调用；内部调用 `apiFetch()`、`setCurrentRun()`、`setAgentRuns()`、`setChatHistory()`、`assistantEntryForRun()`、`some()`。
   */
  async function monitorAgentRun(runId: string, assistantId: string) {
    // 轮询 run 状态，并把后端状态机投影成前端聊天区里的连续反馈。
    if (!token) return;
    let nextTreeRefreshAt = 0;
    let nextContextRefreshAt = 0;
    let lastRenderedRunSnapshot = "";
    try {
      while (true) {
        const data = await apiFetch<{ run: AgentRunView }>(`/agent/runs/${runId}`, { token });
        const run = data.run;
        const runSnapshot = JSON.stringify(run);
        if (runSnapshot !== lastRenderedRunSnapshot) {
          lastRenderedRunSnapshot = runSnapshot;
          setCurrentRun(run);
          setAgentRuns((runs) => [run, ...runs.filter((entry) => entry.id !== run.id)]);
          setLatestRun((latest) => !latest || latest.id === run.id ? run : latest);
          setChatHistory((history) => {
            const nextEntry = assistantEntryForRun(assistantId, run);
            if (!history.some((entry) => entry.id === assistantId)) {
              return [...history, nextEntry];
            }
            return history.map((entry) => entry.id === assistantId ? nextEntry : entry);
          });
        }
        if (Date.now() >= nextTreeRefreshAt) {
          nextTreeRefreshAt = Date.now() + 3000;
          void (reviewMode ? loadReviewAudit() : loadTree());
        }
        if (Date.now() >= nextContextRefreshAt) {
          nextContextRefreshAt = Date.now() + 5000;
          void loadChatContextUsage();
        }

        if (isTerminalRun(run)) {
          if (run.patchPlans?.[0]?.status === "applied") {
            setOpenFiles([]);
            setActiveFile(null);
          }
          // 刷新工作区状态和元数据，但不要在这里调用 loadChatSession()。
          // 前端 chatHistory 已由上面的监控循环正确构建；使用后端 transcript 覆盖它会删除
          // 进行中的消息并重置滚动位置。
          // 刷新已打开文件的内容（Agent 可能修改了磁盘上的文件）
          for (const f of openFiles) {
            try {
              const fileData = await apiFetch<{ path: string; content: string }>(
                reviewMode
                  ? `/teacher/review/audit/file?path=${encodeURIComponent(f.path)}`
                  : `/workspace/file?path=${encodeURIComponent(f.path)}`,
                { token },
              );
              setOpenFiles((files) => files.map((file) =>
                file.path === fileData.path ? { ...file, content: fileData.content, dirty: false } : file
              ));
            } catch { /* keep stale content on error */ }
          }
          await Promise.all([
            reviewMode ? loadReviewAudit() : loadTree(),
            loadAgentRun(run.id),
            reviewMode ? Promise.resolve() : loadCourseTask(),
            loadChatContextUsage(),
          ]);
          return;
        }
        await new Promise((resolve) => window.setTimeout(resolve, 700));
      }
    } catch (error) {
      setChatHistory((history) => history.map((entry) => entry.id === assistantId
        ? { ...entry, content: error instanceof Error ? error.message : "无法读取任务进度。", pending: false }
        : entry));
    } finally {
      setAgentBusy(false);
      setStoppingAgent(false);
    }
  }

  /**
   * 功能：停止`active` Agent。
   * 输入：无显式输入参数。
   * 输出：返回该操作的完成状态；同步处理无结果时返回 void，异步处理返回 Promise。
   * 调用关系：由 `apps/web/src/features/workspace/WorkspacePage.tsx:WorkspacePage()` 调用；内部调用 `setStoppingAgent()`、`apiFetch()`、`setCurrentRun()`、`setAgentRuns()`、`setNotice()`。
   */
  async function stopActiveAgent() {
    if (!token || !currentRun?.id || !agentBusy || stoppingAgent) return;
    setStoppingAgent(true);
    try {
      const data = await apiFetch<{ run: AgentRunView }>(`/agent/runs/${currentRun.id}/stop`, { method: "POST", token });
      setCurrentRun(data.run);
      setAgentRuns((runs) => [data.run, ...runs.filter((run) => run.id !== data.run.id)]);
      setLatestRun((latest) => latest?.id === data.run.id ? data.run : latest);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "无法停止 AI 任务。");
      setStoppingAgent(false);
    }
  }

  /**
   * 功能：打开实验环境。
   * 输入：无显式输入参数。
   * 输出：返回该操作生成、查询或转换后的结果；异步实现以 Promise 交付结果。
   * 调用关系：由本模块其他函数、应用编排层、协议适配层或测试按需调用；内部调用 `setAppMenuOpen()`、`open()`。
   */
  function openLab() {
    setAppMenuOpen(false);
    window.open("/lab", "_blank", "noopener,noreferrer");
  }

  function openPortal() {
    setAppMenuOpen(false);
    window.location.href = "/portal";
  }

  /**
   * 功能：打开工作区 `import` `dialog`。
   * 输入：无显式输入参数。
   * 输出：返回该操作生成、查询或转换后的结果；异步实现以 Promise 交付结果。
   * 调用关系：由本模块其他函数、应用编排层、协议适配层或测试按需调用；内部调用 `setAppMenuOpen()`、`setWorkspaceImportError()`、`setWorkspaceImportSummary()`、`setWorkspaceImportFile()`、`setWorkspaceImportMode()`、`setWorkspaceImportTargetPath()`。
   */
  function openWorkspaceImportDialog() {
    // 工作区导入入口放在左上角菜单，不和聊天附件区域混在一起。
    setAppMenuOpen(false);
    setWorkspaceImportError(null);
    setWorkspaceImportSummary(null);
    setWorkspaceImportFile(null);
    setWorkspaceImportMode("extract");
    setWorkspaceImportTargetPath("");
    setWorkspaceImportOverwritePolicy("fail");
    setWorkspaceImportOpen(true);
  }

  /**
   * 功能：处理`import` 工作区 `archive` `from` `dialog`。
   * 输入：`event`（React.FormEvent<HTMLFormElement>）提供event。
   * 输出：返回该操作生成、查询或转换后的结果；异步实现以 Promise 交付结果。
   * 调用关系：由本模块其他函数、应用编排层、协议适配层或测试按需调用；内部调用 `preventDefault()`、`setWorkspaceImporting()`、`setWorkspaceImportError()`、`setWorkspaceImportSummary()`、`apiFetch()`、`loadTree()`。
   */
  async function importWorkspaceArchiveFromDialog(event: React.FormEvent<HTMLFormElement>) {
    // 这里调用的是工作区导入接口，只负责把归档内容写入学生工程目录。
    event.preventDefault();
    if (!token || !workspaceImportFile) return;
    setWorkspaceImporting(true);
    setWorkspaceImportError(null);
    setWorkspaceImportSummary(null);
    try {
      const formData = new FormData();
      formData.set("file", workspaceImportFile);
      formData.set("mode", workspaceImportMode);
      formData.set("targetPath", workspaceImportTargetPath.trim());
      formData.set("overwritePolicy", workspaceImportOverwritePolicy);
      const data = await apiFetch<{ summary: WorkspaceImportSummary }>("/workspace/import", {
        method: "POST",
        token,
        body: formData
      });
      await loadTree();
      setNotice(`已导入 ${workspaceImportFile.name}：写入 ${data.summary.writtenCount} 个文件，跳过 ${data.summary.skippedCount} 个文件。`);
      setWorkspaceImportOpen(false);
      setWorkspaceImportFile(null);
      setWorkspaceImportSummary(null);
      setWorkspaceImportTargetPath("");
      setWorkspaceImportOverwritePolicy("fail");
      if (workspaceImportInputRef.current) workspaceImportInputRef.current.value = "";
    } catch (error) {
      setWorkspaceImportError(error instanceof Error ? error.message : "无法导入工作区压缩包。");
    } finally {
      setWorkspaceImporting(false);
    }
  }

  /**
   * 功能：下载工作区 `zip`。
   * 输入：无显式输入参数。
   * 输出：返回该操作生成、查询或转换后的结果；异步实现以 Promise 交付结果。
   * 调用关系：由 `apps/web/src/features/workspace/WorkspacePage.tsx:WorkspacePage()` 调用；内部调用 `setAppMenuOpen()`、`fetch()`、`catch()`、`blob()`、`createObjectURL()`、`match()`。
   */
  async function downloadWorkspaceZip() {
    // 下载导出走浏览器原生下载行为，不经过聊天消息体系。
    if (!token) return;
    setAppMenuOpen(false);
    try {
      const response = await fetch("/api/workspace/export.zip", {
        headers: { Authorization: `Bearer ${token}` }
      });
      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(data.message ?? "工作区导出失败。");
      }
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const disposition = response.headers.get("Content-Disposition") ?? "";
      const fileNameMatch = disposition.match(/filename="([^"]+)"/);
      const fileName = fileNameMatch?.[1] ?? "workspace.zip";
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = fileName;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(url);
      setNotice(`已下载 ${fileName}`);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "无法下载工作区 ZIP。");
    }
  }

  /**
   * 功能：下载聊天 产物。
   * 输入：`download`（ChatArtifactDownload）提供download。
   * 输出：返回该操作生成、查询或转换后的结果；异步实现以 Promise 交付结果。
   * 调用关系：由 `apps/web/src/features/workspace/WorkspacePage.tsx:WorkspacePage()` 调用；内部调用 `fetch()`、`encodeURIComponent()`、`catch()`、`blob()`、`createObjectURL()`、`match()`。
   */
  async function downloadChatArtifact(download: ChatArtifactDownload) {
    // 聊天产物下载接口需要 Bearer token，不能直接用普通 <a href>。
    if (!token) return;
    try {
      const response = await fetch(`/api/agent/session-artifacts/${encodeURIComponent(download.artifactId)}/download`, {
        headers: { Authorization: `Bearer ${token}` }
      });
      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(data.message ?? "产物下载失败。");
      }
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const disposition = response.headers.get("Content-Disposition") ?? "";
      const fileNameMatch = disposition.match(/filename="([^"]+)"/);
      const fileName = fileNameMatch?.[1] ?? download.fileName;
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = fileName;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(url);
      setNotice(`已下载 ${fileName}`);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "无法下载聊天产物。");
    }
  }

  /**
   * 功能：重置`ai` 上下文。
   * 输入：无显式输入参数。
   * 输出：返回该操作生成、查询或转换后的结果；异步实现以 Promise 交付结果。
   * 调用关系：由 `apps/web/src/features/workspace/WorkspacePage.tsx:WorkspacePage()` 调用；内部调用 `confirm()`、`setResettingAiContext()`、`apiFetch()`、`setSettingsMessage()`。
   */
  async function resetAiContext() {
    if (!token || !window.confirm(reviewMode
      ? "确认重置审阅会话的运行状态吗？学生工作区、审阅记录和 AI 服务商设置不会改变。"
      : "确认重置会话状态吗？项目文件和 AI 服务商设置不会改变。")) return;
    setResettingAiContext(true);
    try {
      const data = await apiFetch<{ message: string }>("/ai/context/reset", { method: "POST", token });
      await loadChatContextUsage();
      setNotice(data.message);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "无法重置会话状态。");
    } finally {
      setResettingAiContext(false);
    }
  }

  /**
   * 功能：启动新会话 聊天 会话。
   * 输入：无显式输入参数。
   * 输出：返回该操作生成、查询或转换后的结果；异步实现以 Promise 交付结果。
   * 调用关系：由 `apps/web/src/features/workspace/WorkspacePage.tsx:submitChat()`、`apps/web/src/features/workspace/WorkspacePage.tsx:WorkspacePage()` 调用；内部调用 `confirm()`、`setChatPrompt()`、`apiFetch()`、`stringify()`、`setChatSession()`、`setPromptHistory()`。
   */
  async function startNewChatSession() {
    if (!token || agentBusy) return;
    const confirmed = window.confirm(reviewMode
      ? "请确认是否结束当前审阅对话并开始一个新会话？学生工作区不会改变。"
      : "请确认是否清空工作区，并重新开始工程");
    if (!confirmed) {
      return false;
    }
    try {
      const data = await apiFetch<{ chat: ChatSessionSnapshot }>("/agent/chat-sessions/new", {
        method: "POST",
        token,
        body: JSON.stringify({
          reason: "user_slash_new",
          confirmed: true,
          mode: agentMode,
        })
      });
      setChatSession(data.chat);
      setPromptHistory(data.chat.history
        .filter((entry) => entry.role === "user")
        .map((entry) => entry.content));
      const restoredHistory = collapseAgentRunHistory(data.chat.history).map((entry) => ({
        id: entry.id,
        role: entry.role,
        content: entry.content,
        runId: entry.runId,
        chinese: prefersChinese(entry.content),
        attachments: entry.attachments,
      }));
      setChatHistory(restoredHistory);
      setOpenFiles([]);
      setActiveFile(null);
      for (const previewUrl of uploadPreviewUrlsRef.current.values()) {
        URL.revokeObjectURL(previewUrl);
      }
      uploadPreviewUrlsRef.current.clear();
      for (const previewUrl of historyPreviewUrlsRef.current.values()) {
        URL.revokeObjectURL(previewUrl);
      }
      historyPreviewUrlsRef.current.clear();
      historyPreviewRequestRef.current += 1;
      void loadHistoryAttachmentPreviews(restoredHistory);
      setStagedUploads([]);
      setCurrentRun(null);
      setLatestRun(null);
      await (reviewMode ? loadReviewAudit() : loadTree());
      if (!reviewMode) await loadCourseTask();
      setNotice("已开始新会话。");
      return true;
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "无法开始新会话。");
      return false;
    }
  }

  /**
   * 功能：选择`view`。
   * 输入：`view`（ViewKey）提供view。
   * 输出：返回该操作生成、查询或转换后的结果；异步实现以 Promise 交付结果。
   * 调用关系：由 `apps/web/src/features/workspace/WorkspacePage.tsx:WorkspacePage()` 调用；内部调用 `setSidebarOpen()`、`setActiveView()`、`loadClassProgress()`。
   */
  function selectView(view: ViewKey) {
    if (activeView === view && sidebarOpen) setSidebarOpen(false);
    else {
      setActiveView(view);
      setSidebarOpen(true);
      if (view === "class") void loadClassProgress();
    }
  }

  if (!workspace || workspace.status !== "ready") {
    return (
      <div className="wb-onboarding">
        <div className="wb-onboarding-card">
          <div className="wb-mark">CW</div>
          <p className="eyebrow">AES</p>
          <h1>准备你的课程工作区</h1>
          <p>系统将为 {user?.email} 准备独立主目录、RISC-V 工具链、AI 配置和 QEMU 实验环境。</p>
          <button className="wb-primary large" onClick={() => void initializeWorkspace()}>
            初始化工作区 <Icon name="arrow" size={17} />
          </button>
          <button className="wb-text-button" onClick={logout}>退出登录</button>
        </div>
      </div>
    );
  }

  return (
    <div className={`workbench ${workbenchTheme}`}>
      <header className="wb-titlebar">
        <div className="wb-app-menu-wrap">
          <button className={`wb-brand ${appMenuOpen ? "open" : ""}`} onClick={() => setAppMenuOpen((open) => !open)}>
            <span className="wb-brand-glyph">C</span>
            <span>Courseworks</span>
            <Icon name="chevron" size={12} />
          </button>
          {appMenuOpen ? (
            <div className="wb-app-menu">
              {!reviewMode ? <>
                <button onClick={openLab}>
                  <Icon name="screen" size={15} />
                  <span><strong>QEMU / noVNC</strong><small>在新标签页打开操作系统实验</small></span>
                </button>
                <button onClick={openWorkspaceImportDialog}>
                  <Icon name="folderPlus" size={15} />
                  <span><strong>导入工作区...</strong><small>支持 .zip、.tar.gz、.tgz、.tar.bz2、.tbz2</small></span>
                </button>
                <button onClick={() => void downloadWorkspaceZip()}>
                  <Icon name="arrow" size={15} />
                  <span><strong>下载工作区 ZIP</strong><small>导出当前工作区的工程文件</small></span>
                </button>
              </> : null}
              {user?.role === "teacher" && !reviewMode ? (
                <button onClick={() => { setAppMenuOpen(false); window.location.href = "/review"; }}>
                  <Icon name="search" size={15} />
                  <span><strong>进入审阅状态</strong><small>查看班级学生的 Courseworks 工作区</small></span>
                </button>
              ) : null}
              {reviewMode ? (
                <button onClick={() => { setAppMenuOpen(false); window.location.href = "/app"; }}>
                  <Icon name="arrow" size={15} />
                  <span><strong>进入工作状态</strong><small>返回教师自己的 Courseworks 工程</small></span>
                </button>
              ) : null}
              <div className="wb-menu-separator" />
              <button onClick={() => { setWorkbenchTheme((theme) => theme === "dark" ? "light" : "dark"); setAppMenuOpen(false); }}>
                <Icon name="theme" size={15} />
                <span><strong>{workbenchTheme === "dark" ? "使用浅色主题" : "使用深色主题"}</strong><small>当前：{workbenchTheme === "dark" ? "深色" : "浅色"}</small></span>
              </button>
              <button onClick={openPortal}>
                <Icon name="users" size={15} />
                <span><strong>返回服务入口</strong><small>选择其他系统服务</small></span>
              </button>
            </div>
          ) : null}
        </div>
        <div className="wb-command-center">
          <Icon name="search" size={14} />
          <span>{reviewMode ? "audit / 学生工作区" : `${workspace.workspaceUuid.slice(0, 8)} / 工程`}</span>
        </div>
        <div className="wb-window-actions">
          <span className={`wb-provider-dot ${aiSettings.configured ? "online" : ""}`} />
          <span
            className="wb-provider-model"
            title={aiSettings.configured
              ? `${aiSettings.model} · ${REASONING_EFFORT_LABELS[aiSettings.reasoningEffort ?? "default"]}`
              : "未配置 AI 服务商"}
          >
            {aiSettings.configured
              ? `${aiSettings.model} · ${REASONING_EFFORT_LABELS[aiSettings.reasoningEffort ?? "default"]}`
              : "未配置 AI 服务商"}
          </span>
          <span className="wb-account-status" title={user?.email}><Icon name="account" size={13} />{user?.email}</span>
        </div>
      </header>

      <div className="wb-body">
        <nav className="wb-activitybar" aria-label="工作区视图">
          <div>
            <ActivityButton active={activeView === "explorer" && sidebarOpen} label="资源管理器" icon="files" onClick={() => selectView("explorer")} />
            <ActivityButton active={panelOpen} label="AI 助手" icon="spark" onClick={() => setPanelOpen((open) => !open)} />
            {!reviewMode ? <ActivityButton active={activeView === "runs" && sidebarOpen} label="运行记录" icon="history" onClick={() => selectView("runs")} /> : null}
            {!reviewMode && (user?.role === "teacher" || user?.role === "ta") ? (
              <ActivityButton active={activeView === "class" && sidebarOpen} label="班级" icon="users" onClick={() => selectView("class")} />
            ) : null}
          </div>
          <div>
            <ActivityButton label="退出登录" icon="account" onClick={logout} />
          </div>
        </nav>

        {sidebarOpen ? (
          <WorkspaceSidebar
            width={sidebarWidth}
            activeView={activeView}
            tree={tree}
            activeFile={activeFile}
            createEntry={createEntry}
            createPath={createPath}
            collapsedDirectories={collapsedDirectories}
            setCollapsedDirectories={setCollapsedDirectories}
            agentRuns={visibleAgentRuns}
            currentRunId={currentRun?.id}
            classProgress={classProgress}
            onClose={handleCloseSidebar}
            onCreateEntryChange={setCreateEntry}
            onCreatePathChange={setCreatePath}
            onCreateEntry={handleCreateWorkspaceEntry}
            onOpenFile={handleOpenFile}
            onOpenRun={handleOpenRun}
            readOnly={reviewMode}
          />
        ) : null}
        {sidebarOpen ? (
          <div
            className="wb-resize-handle"
            title="调整资源管理器宽度"
            onMouseDown={(event) => {
              resizeRef.current = { target: "sidebar", startX: event.clientX, startWidth: sidebarWidth };
              document.body.style.cursor = "col-resize";
              document.body.style.userSelect = "none";
            }}
          />
        ) : null}

        <WorkspaceEditor
          token={token ?? ""}
          theme={workbenchTheme}
          currentFile={currentFile}
          openFiles={openFiles}
          activeFile={activeFile}
          editorRef={monacoEditorRef}
          onActiveFileChange={setActiveFile}
          onCloseFile={handleCloseFile}
          onContentChange={handleUpdateCurrentFile}
          onOpenFile={handleOpenFile}
          onOpenAssistant={handleOpenAssistant}
          readOnly={reviewMode}
          rootLabel={reviewMode ? "审阅" : "main"}
        />

        {panelOpen ? (
          <>
          <div
            className="wb-resize-handle assistant"
            title="调整 AI 助手宽度"
            onMouseDown={(event) => {
              resizeRef.current = { target: "assistant", startX: event.clientX, startWidth: assistantWidth };
              document.body.style.cursor = "col-resize";
              document.body.style.userSelect = "none";
            }}
          />
          <AssistantPanel
            width={assistantWidth}
            mode={agentMode}
            busy={agentBusy}
            stopping={stoppingAgent}
            usesChinese={agentUsesChinese}
            activityLabel={agentActivity}
            chatHistory={chatHistory}
            latestRun={latestRun}
            courseTask={reviewMode ? null : courseTask}
            chatSession={chatSession}
            stagedUploads={stagedUploads}
            promptHistory={promptHistory}
            aiConfigured={Boolean(aiSettings.configured)}
            uploadingFile={uploadingFile}
            resettingContext={resettingAiContext}
            onClose={handleCloseAssistant}
            onResetContext={() => void resetAiContext()}
            onStartNewSession={handleStartNewChatSession}
            onToggleActivity={handleToggleChatActivity}
            onDownloadArtifact={handleDownloadChatArtifact}
            onRemoveUpload={handleRemoveStagedUpload}
            onPasteAttachment={handlePasteConversationAttachment}
            onSubmit={handleSubmitChat}
            onStop={handleStopActiveAgent}
            onUpload={handleUploadConversationAttachments}
          />
          </>
        ) : null}
      </div>

      <footer className="wb-statusbar">
        <div>
          <span><Icon name="branch" size={12} /> {reviewMode ? "审阅" : "main"}</span>
          {reviewMode ? <span>只读模式</span> : <><span>0 个错误</span><span>0 个警告</span></>}
        </div>
        {reviewMode ? (
          <div><button onClick={() => setPanelOpen((open) => !open)}><Icon name="panel" size={12} /> 审核 AI</button><span>学生工作区</span><span>会话自动保存</span></div>
        ) : (
          <div>
            <button onClick={() => setPanelOpen((open) => !open)}><Icon name="panel" size={12} /> AI 助手</button>
            <span>riscv64</span>
            <span>QEMU virt</span>
            <span>{runReady ? "构建就绪" : lastBuild?.status === "failed" ? "构建失败" : lastBuild?.status === "running" ? "构建中" : "尚未构建"}</span>
          </div>
        )}
      </footer>

      {notice ? <div className="wb-toast">{notice}</div> : null}
      {workspaceImportOpen && !reviewMode ? (
        <WorkspaceImportDialog
          file={workspaceImportFile}
          mode={workspaceImportMode}
          overwritePolicy={workspaceImportOverwritePolicy}
          targetPath={workspaceImportTargetPath}
          importing={workspaceImporting}
          summary={workspaceImportSummary}
          error={workspaceImportError}
          fileInputRef={workspaceImportInputRef}
          onClose={() => setWorkspaceImportOpen(false)}
          onSubmit={importWorkspaceArchiveFromDialog}
          onPickFile={(file) => setWorkspaceImportFile(file)}
          onModeChange={setWorkspaceImportMode}
          onOverwritePolicyChange={setWorkspaceImportOverwritePolicy}
          onTargetPathChange={setWorkspaceImportTargetPath}
        />
      ) : null}
    </div>
  );
}
