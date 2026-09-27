/**
 * 文件作用：实现工作台中的 AI 助手面板，并隔离输入、历史记录和状态栏的渲染。
 * 模块位置：`apps/web/src/features/workspace/AssistantPanel.tsx`，属于前端工作台模块。
 */
import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { ChangeEvent, ClipboardEvent, KeyboardEvent } from "react";
import DOMPurify from "dompurify";
import { marked } from "marked";

import { Icon } from "./workspace-icons";
import type { AgentRunTraceDetail } from "./agent-run-activity";
import {
  DEFAULT_VISIBLE_CHAT_ENTRIES,
  getChatHistoryWindow,
  nextVisibleChatEntryCount,
} from "./chat-history-window";
import type {
  AgentRunView,
  ChatArtifactDownload,
  ChatEntry,
  ChatSessionSnapshot,
  CourseTaskView,
  StagedUpload,
} from "./workspace-types";
import {
  extractChatArtifactDownloads,
  formatAgentContextUsage,
  formatUploadSize,
  isPromptHistoryVisualBoundary,
  navigatePromptHistory,
  nextStreamingTextFrame,
  stripChatArtifactDownloadMarkers,
} from "./workspace-utils";
import type { PromptHistoryNavigation } from "./workspace-utils";

type AssistantPanelProps = {
  width: number;
  mode?: "work" | "review";
  busy: boolean;
  stopping: boolean;
  usesChinese: boolean;
  activityLabel: string;
  chatHistory: ChatEntry[];
  latestRun: AgentRunView | null;
  courseTask: CourseTaskView | null;
  chatSession: ChatSessionSnapshot | null;
  stagedUploads: StagedUpload[];
  promptHistory: string[];
  aiConfigured: boolean;
  uploadingFile: boolean;
  resettingContext: boolean;
  onClose: () => void;
  onResetContext: () => void;
  onStartNewSession: () => Promise<boolean | void>;
  onToggleActivity: (entry: ChatEntry) => void;
  onDownloadArtifact: (download: ChatArtifactDownload) => void;
  onRemoveUpload: (uploadId: string) => void;
  onPasteAttachment: (event: ClipboardEvent<HTMLTextAreaElement>) => void;
  onSubmit: (prompt: string) => void;
  onStop: () => void;
  onUpload: (event: ChangeEvent<HTMLInputElement>) => void;
};

function useLatestCallback<Args extends unknown[], Result>(
  callback: (...args: Args) => Result,
): (...args: Args) => Result {
  const callbackRef = useRef(callback);
  callbackRef.current = callback;
  return useCallback((...args: Args) => callbackRef.current(...args), []);
}

const MarkdownContent = memo(function MarkdownContent({ content }: { content: string }) {
  const html = useMemo(
    () => DOMPurify.sanitize(marked.parse(content, { breaks: true }) as string),
    [content],
  );
  return <div className="wb-chat-final" dangerouslySetInnerHTML={{ __html: html }} />;
});

const StreamingMarkdownContent = memo(function StreamingMarkdownContent(props: {
  content: string;
  active: boolean;
}) {
  const [visibleContent, setVisibleContent] = useState(props.content);

  useEffect(() => {
    if (!props.active || !props.content.startsWith(visibleContent)) {
      setVisibleContent(props.content);
      return;
    }
    if (visibleContent === props.content) return;
    const timer = window.setTimeout(() => {
      setVisibleContent((current) => nextStreamingTextFrame(current, props.content));
    }, 80);
    return () => window.clearTimeout(timer);
  }, [props.active, props.content, visibleContent]);

  return <MarkdownContent content={visibleContent} />;
});

const ActivityTrace = memo(function ActivityTrace(props: {
  trace: AgentRunTraceDetail;
  chinese: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const { trace } = props;

  if (trace.kind === "assistant" || trace.kind === "thinking") {
    return (
      <div className={`wb-trace-line ${trace.kind} ${trace.status}`}>
        {trace.kind === "thinking" ? (
          <span className="wb-trace-kind">思考</span>
        ) : null}
        <MarkdownContent content={trace.detail} />
      </div>
    );
  }

  const expandable = trace.kind === "tool" && Boolean(trace.detail.trim());
  return (
    <div className={`wb-trace-line ${trace.kind} ${trace.status}`}>
      {expandable ? (
        <button
          type="button"
          className="wb-trace-toggle"
          aria-label={expanded ? "收起工具详情" : "展开工具详情"}
          aria-expanded={expanded}
          onClick={() => setExpanded((value) => !value)}
        >
          {expanded ? "▾" : "▸"}
        </button>
      ) : <span className="wb-trace-spacer" />}
      <span className="wb-trace-summary">{trace.summary}</span>
      {expanded ? <pre className="wb-trace-detail">{trace.detail}</pre> : null}
    </div>
  );
});

const ChatMessage = memo(function ChatMessage(props: {
  entry: ChatEntry;
  onToggleActivity: (entry: ChatEntry) => void;
  onDownloadArtifact: (download: ChatArtifactDownload) => void;
}) {
  const { entry } = props;
  const downloads = useMemo(
    () => entry.role === "assistant" ? extractChatArtifactDownloads(entry.content) : [],
    [entry.content, entry.role],
  );
  const visibleContent = useMemo(
    () => downloads.length ? stripChatArtifactDownloadMarkers(entry.content) : entry.content,
    [downloads.length, entry.content],
  );
  const visibleActivity = Array.isArray(entry.activity)
    ? entry.pending ? entry.activity : entry.activity.filter((trace) => trace.kind !== "thinking")
    : [];

  return (
    <article className={`wb-chat-entry ${entry.role}${entry.pending ? " pending" : ""}`}>
      <div className="wb-chat-entry-heading">
        <div className="wb-chat-author">
          <span className="wb-chat-avatar">
            <Icon name={entry.role === "user" ? "account" : "spark"} size={14} />
          </span>
          <div>
            <strong>{entry.role === "user" ? "你" : "Courseworks"}</strong>
            {entry.pending ? <small>正在工作</small> : null}
          </div>
        </div>
        {entry.role === "assistant" && entry.pending && !entry.activity && entry.runId ? (
          <button
            type="button"
            className="wb-chat-activity-toggle"
            onClick={() => props.onToggleActivity(entry)}
          >
            加载过程
          </button>
        ) : null}
      </div>
      <div className="wb-chat-content">
        {visibleActivity.length ? (
          <div className="wb-chat-timeline">
            {visibleActivity.map((trace) => (
              <ActivityTrace key={trace.id} trace={trace} chinese={Boolean(entry.chinese)} />
            ))}
          </div>
        ) : typeof entry.activity === "string" ? (
          <div className="wb-chat-activity-note">{entry.activity}</div>
        ) : null}
        {entry.pending && entry.thinking?.trim() ? (
          <div className="wb-thinking-stream running">
            <span>思考</span>
            <MarkdownContent content={entry.thinking} />
          </div>
        ) : null}
        <StreamingMarkdownContent
          content={visibleContent}
          active={entry.role === "assistant" && Boolean(entry.pending)}
        />
        {entry.attachments?.length ? (
          <div className="wb-chat-history-attachments">
            {entry.attachments.map((attachment) => attachment.previewUrl ? (
              <a
                key={attachment.id}
                className="wb-chat-history-image"
                href={attachment.previewUrl}
                target="_blank"
                rel="noreferrer"
                title={attachment.originalName}
              >
                <img src={attachment.previewUrl} alt={attachment.originalName} />
                <span>{attachment.originalName}</span>
              </a>
            ) : (
              <span key={attachment.id} className="wb-chat-history-file">
                {attachment.originalName}
              </span>
            ))}
          </div>
        ) : null}
        {downloads.length ? (
          <div className="wb-chat-downloads">
            {downloads.map((download) => (
              <button
                key={download.artifactId}
                type="button"
                className="wb-chat-download"
                onClick={() => props.onDownloadArtifact(download)}
              >
                下载 {download.fileName}
              </button>
            ))}
          </div>
        ) : null}
      </div>
    </article>
  );
});

const ChatHistory = memo(function ChatHistory(props: {
  history: ChatEntry[];
  reviewMode: boolean;
  onToggleActivity: (entry: ChatEntry) => void;
  onDownloadArtifact: (download: ChatArtifactDownload) => void;
}) {
  const [visibleCount, setVisibleCount] = useState(DEFAULT_VISIBLE_CHAT_ENTRIES);
  const historyRef = useRef<HTMLDivElement | null>(null);
  const stickToBottomRef = useRef(true);
  const restoreScrollRef = useRef<{ height: number; top: number } | null>(null);
  const windowed = useMemo(
    () => getChatHistoryWindow(props.history, visibleCount),
    [props.history, visibleCount],
  );

  useLayoutEffect(() => {
    const element = historyRef.current;
    if (!element) return;
    const restore = restoreScrollRef.current;
    if (restore) {
      element.scrollTop = restore.top + element.scrollHeight - restore.height;
      restoreScrollRef.current = null;
      return;
    }
    if (stickToBottomRef.current) element.scrollTop = element.scrollHeight;
  }, [props.history, visibleCount]);

  function loadEarlierMessages() {
    const element = historyRef.current;
    if (element) {
      restoreScrollRef.current = { height: element.scrollHeight, top: element.scrollTop };
    }
    setVisibleCount((current) => nextVisibleChatEntryCount(current, props.history.length));
  }

  return (
    <div
      className="wb-chat-history"
      ref={historyRef}
      onScroll={(event) => {
        const element = event.currentTarget;
        stickToBottomRef.current = element.scrollHeight - element.scrollTop - element.clientHeight < 96;
      }}
    >
      {windowed.hiddenCount > 0 ? (
        <button type="button" className="wb-chat-load-earlier" onClick={loadEarlierMessages}>
          加载更早的消息（还有 {windowed.hiddenCount} 条）
        </button>
      ) : null}
      {!props.history.length ? (
        <div className="wb-chat-empty">
          <Icon name="spark" size={20} />
          <span>{props.reviewMode
            ? "请输入审阅要求，可以检查单个学生、比较多个学生或批量总结全班。命令：`/new` 新会话 · `/compact` 压缩 · `/tools` 列表 · `/context` 查看上下文"
            : "请描述要构建、讲解或修复的操作系统功能。命令：`/new` 重置 · `/compact` 压缩 · `/tools` 列表 · `/context` 查看上下文"}</span>
        </div>
      ) : windowed.entries.map((entry) => (
        <ChatMessage
          key={entry.id}
          entry={entry}
          onToggleActivity={props.onToggleActivity}
          onDownloadArtifact={props.onDownloadArtifact}
        />
      ))}
    </div>
  );
});

const ChatComposer = memo(function ChatComposer(props: {
  busy: boolean;
  stopping: boolean;
  aiConfigured: boolean;
  uploadingFile: boolean;
  stagedUploads: StagedUpload[];
  promptHistory: string[];
  resetKey: number;
  reviewMode: boolean;
  onRemoveUpload: (uploadId: string) => void;
  onPasteAttachment: (event: ClipboardEvent<HTMLTextAreaElement>) => void;
  onSubmit: (prompt: string) => void;
  onStop: () => void;
  onUpload: (event: ChangeEvent<HTMLInputElement>) => void;
}) {
  const [prompt, setPrompt] = useState("");
  const uploadInputRef = useRef<HTMLInputElement | null>(null);
  const promptHistoryNavigationRef = useRef<PromptHistoryNavigation>({ index: null, draft: "" });

  useEffect(() => {
    setPrompt("");
    promptHistoryNavigationRef.current = { index: null, draft: "" };
  }, [props.resetKey]);

  function changePrompt(value: string) {
    promptHistoryNavigationRef.current = { index: null, draft: "" };
    setPrompt(value);
  }

  function submitPrompt() {
    const value = prompt.trim();
    if (!value || props.busy || !props.aiConfigured) return;
    setPrompt("");
    promptHistoryNavigationRef.current = { index: null, draft: "" };
    props.onSubmit(value);
  }

  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.nativeEvent.isComposing) return;
    if (
      (event.key === "ArrowUp" || event.key === "ArrowDown")
      && !event.altKey
      && !event.ctrlKey
      && !event.metaKey
      && !event.shiftKey
    ) {
      const direction = event.key === "ArrowUp" ? "older" : "newer";
      if (!isPromptHistoryVisualBoundary(event.currentTarget, direction)) return;
      const result = navigatePromptHistory(
        props.promptHistory,
        prompt,
        promptHistoryNavigationRef.current,
        direction,
      );
      if (!result) return;
      event.preventDefault();
      promptHistoryNavigationRef.current = result.navigation;
      setPrompt(result.value);
      const textarea = event.currentTarget;
      window.requestAnimationFrame(() => {
        const position = direction === "older" ? 0 : result.value.length;
        textarea.setSelectionRange(position, position);
      });
      return;
    }
    if (event.key !== "Enter" || event.shiftKey) return;
    event.preventDefault();
    submitPrompt();
  }

  return (
    <>
      <div className="wb-chat-composer">
        {props.stagedUploads.length ? (
          <div className="wb-chat-attachments">
            {props.stagedUploads.map((upload) => (
              <button
                key={upload.id}
                type="button"
                className="wb-chat-attachment"
                title="会话附件，点击移除。"
                onClick={() => props.onRemoveUpload(upload.id)}
              >
                {upload.previewUrl ? <img src={upload.previewUrl} alt="" /> : null}
                <span>{upload.originalName}</span>
                <small>{formatUploadSize(upload.size)}</small>
                <strong>×</strong>
              </button>
            ))}
          </div>
        ) : null}
        <textarea
          value={prompt}
          onChange={(event) => changePrompt(event.target.value)}
          onKeyDown={handleKeyDown}
          onPaste={props.onPasteAttachment}
          placeholder={props.aiConfigured
            ? props.reviewMode ? "请输入单个或批量审阅要求..." : "请描述你的任务..."
            : "请先配置 AI 服务商"}
          rows={3}
        />
        <div className="wb-chat-toolbar">
          <button
            type="button"
            className="wb-chat-upload"
            title="为当前会话添加本地文件"
            disabled={props.uploadingFile}
            onClick={() => uploadInputRef.current?.click()}
          >
            {props.uploadingFile ? "…" : "+"}
          </button>
          <span>
            {props.stagedUploads.length
              ? `已添加 ${props.stagedUploads.length} 个附件`
              : "尚未添加附件"}
          </span>
          <button
            type="button"
            className={props.busy ? "wb-chat-stop" : ""}
            disabled={props.busy ? props.stopping : !props.aiConfigured || !prompt.trim()}
            title={props.busy ? "停止 AI 任务" : "发送提示词"}
            onClick={props.busy ? props.onStop : submitPrompt}
          >
            <Icon name={props.busy ? "stop" : "send"} size={15} />
          </button>
        </div>
      </div>
      <input ref={uploadInputRef} type="file" multiple hidden onChange={props.onUpload} />
    </>
  );
});

export const AssistantPanel = memo(function AssistantPanel(props: AssistantPanelProps) {
  const [composerResetKey, setComposerResetKey] = useState(0);
  const [assistantMenuOpen, setAssistantMenuOpen] = useState(false);
  const assistantMenuRef = useRef<HTMLDivElement | null>(null);
  const stableToggleActivity = useLatestCallback(props.onToggleActivity);
  const stableDownloadArtifact = useLatestCallback(props.onDownloadArtifact);
  const stableRemoveUpload = useLatestCallback(props.onRemoveUpload);
  const stableSubmit = useLatestCallback(props.onSubmit);
  const stableStop = useLatestCallback(props.onStop);
  const stableUpload = useLatestCallback(props.onUpload);
  const startNewSessionRef = useRef(props.onStartNewSession);
  startNewSessionRef.current = props.onStartNewSession;
  const handleStartNewSession = useCallback(async () => {
    const started = await startNewSessionRef.current();
    if (started) setComposerResetKey((key) => key + 1);
  }, []);

  useEffect(() => {
    if (!assistantMenuOpen) return;
    const closeOnOutsideClick = (event: MouseEvent) => {
      if (!assistantMenuRef.current?.contains(event.target as Node)) setAssistantMenuOpen(false);
    };
    const closeOnEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") setAssistantMenuOpen(false);
    };
    window.addEventListener("mousedown", closeOnOutsideClick);
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      window.removeEventListener("mousedown", closeOnOutsideClick);
      window.removeEventListener("keydown", closeOnEscape);
    };
  }, [assistantMenuOpen]);

  const contextUsage = props.chatSession?.contextUsage;
  const contextPercent = contextUsage?.percent;
  const contextTone = contextPercent !== null && contextPercent !== undefined
    ? contextPercent > 90 ? "error" : contextPercent > 70 ? "warning" : "normal"
    : "unknown";
  const contextTitle = contextUsage && contextUsage.contextWindow > 0
    ? `上下文：${contextUsage.tokens?.toLocaleString() ?? "未知"} / ${contextUsage.contextWindow.toLocaleString()} Token${contextUsage.percent === null ? "" : `（${contextUsage.percent.toFixed(1)}%）`} · 已启用自动压缩`
    : "暂无上下文用量信息";

  return (
    <aside className="wb-panel" style={{ flexBasis: props.width, width: props.width }}>
      <div className="wb-panel-tabs">
        <button className="active">{props.mode === "review" ? "审阅 AI" : "AI 助手"}</button>
        <span className={`wb-context-usage ${contextTone}`} title={contextTitle}>
          {formatAgentContextUsage(contextUsage)}
        </span>
        <span className={`wb-run-status ${props.busy ? "running" : "success"}`} />
        <span className={`wb-panel-activity ${props.busy ? "wb-agent-activity" : ""}`}>
          {props.stopping
            ? "正在停止..."
            : props.activityLabel}
        </span>
        <div className="wb-assistant-menu-wrap" ref={assistantMenuRef}>
          <button
            type="button"
            className="wb-assistant-menu-trigger"
            aria-label="AI 助手操作"
            aria-expanded={assistantMenuOpen}
            title="AI 助手操作"
            onClick={() => setAssistantMenuOpen((open) => !open)}
          >
            <Icon name="more" size={16} />
          </button>
          {assistantMenuOpen ? (
            <div className="wb-assistant-menu" role="menu">
              <button
                type="button"
                role="menuitem"
                disabled={props.busy}
                onClick={() => {
                  setAssistantMenuOpen(false);
                  void handleStartNewSession();
                }}
              >
                <Icon name="plus" size={15} />
                <span>
                  <strong>新会话</strong>
                  <small>{props.mode === "review" ? "结束当前对话并开始新的班级审阅" : "结束当前对话并开始新的工程会话"}</small>
                </span>
              </button>
              <button
                type="button"
                role="menuitem"
                disabled={props.busy || props.resettingContext}
                onClick={() => {
                  setAssistantMenuOpen(false);
                  props.onResetContext();
                }}
              >
                <Icon name="history" size={15} />
                <span>
                  <strong>{props.resettingContext ? "正在重置..." : "重置会话状态"}</strong>
                  <small>{props.mode === "review" ? "保留学生工作区和模型设置" : "保留项目文件和模型设置"}</small>
                </span>
              </button>
            </div>
          ) : null}
        </div>
        <button className="wb-panel-close" aria-label="关闭 AI 助手" title="关闭 AI 助手" onClick={props.onClose}>
          <Icon name="close" size={14} />
        </button>
      </div>
      <ChatHistory
        key={props.chatSession?.currentSessionId ?? "pending-session"}
        history={props.chatHistory}
        reviewMode={props.mode === "review"}
        onToggleActivity={stableToggleActivity}
        onDownloadArtifact={stableDownloadArtifact}
      />
      <ChatComposer
        busy={props.busy}
        stopping={props.stopping}
        aiConfigured={props.aiConfigured}
        uploadingFile={props.uploadingFile}
        stagedUploads={props.stagedUploads}
        promptHistory={props.promptHistory}
        resetKey={composerResetKey}
        reviewMode={props.mode === "review"}
        onRemoveUpload={stableRemoveUpload}
        onPasteAttachment={props.onPasteAttachment}
        onSubmit={stableSubmit}
        onStop={stableStop}
        onUpload={stableUpload}
      />
    </aside>
  );
});
