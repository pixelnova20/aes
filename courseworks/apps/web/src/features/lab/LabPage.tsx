/**
 * 文件作用：实现前端“实验终端”功能模块的 React 界面与交互。
 * 模块位置：`apps/web/src/features/lab/LabPage.tsx`，属于前端“实验终端”功能模块。
 * 重要函数：`LabPage()` 负责处理实验环境 页面。
 */
import { useEffect, useRef, useState, type CSSProperties } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import RFB from "@novnc/novnc";
import "@xterm/xterm/css/xterm.css";

import { apiFetch } from "../../shared/api/client";
import { useAuth } from "../auth/auth-context";
import { Icon } from "../workspace/workspace-icons";

const DEFAULT_TERMINAL_PANE_RATIO = 0.68;
const MIN_TERMINAL_PANE_RATIO = 0.35;
const MAX_TERMINAL_PANE_RATIO = 0.78;
const LAB_SPLIT_STORAGE_KEY = "courseworks-lab-terminal-pane-ratio";
const LAB_THEME_STORAGE_KEY = "courseworks-workbench-theme";
const DEFAULT_MAX_WORKSPACE_SHELLS = 5;
const LAB_BUILD_REVISION = "2026-09-18-stale-lab-container-v2";

type LabTheme = "light" | "dark";

// Lab 页面里既有“运行中的 QEMU 会话”，也有“多个 workspace shell”。
type QemuSession = {
  runId: string;
  status: "idle" | "running" | "stopped" | "failed" | "timeout" | "error" | "resource_limit_exceeded" | "idle_timeout";
  output: string;
  exitCode: number | null;
  startedAt: string | null;
  finishedAt: string | null;
};

type TerminalServerEvent =
  | { type: "snapshot"; session: QemuSession }
  | { type: "output"; data: string }
  | { type: "status"; session: QemuSession }
  | { type: "resized"; columns: number; rows: number }
  | { type: "error"; message: string };

type VncProbeStatus = {
  state: "available" | "waiting_for_qemu" | "runtime_starting" | "session_stopped";
  message: string;
};

type VncViewState = {
  phase: "idle" | "checking" | "waiting" | "connecting" | "displaying" | "disconnected" | "error";
  message: string;
  attempts: number;
  dimensions?: string;
};

const VNC_PHASE_LABELS: Record<VncViewState["phase"], string> = {
  idle: "实验会话空闲",
  checking: "正在检查 VNC",
  waiting: "正在等待 QEMU",
  connecting: "正在连接 QEMU",
  displaying: "正在显示 QEMU 输出",
  disconnected: "VNC 连接已中断",
  error: "VNC 连接错误",
};

const SESSION_STATUS_LABELS: Record<QemuSession["status"], string> = {
  idle: "空闲",
  running: "运行中",
  stopped: "已停止",
  failed: "失败",
  timeout: "超时",
  error: "错误",
  resource_limit_exceeded: "超出资源限制",
  idle_timeout: "空闲超时",
};

const TERMINAL_THEMES = {
  dark: { background: "#070a09", foreground: "#bcebdc", cursor: "#77e8cf", selectionBackground: "#24584d" },
  light: { background: "#ffffff", foreground: "#18312c", cursor: "#087f6b", selectionBackground: "#b9e7dc" },
} as const;

function messageFromError(error: unknown, fallback: string) {
  return error instanceof Error ? error.message : fallback;
}

function isStaleLabContainerMessage(message: string) {
  return (
    /No such container:?\s*courseworks-(shell|runtime)-/.test(message)
    || /container\s+courseworks-(shell|runtime)-[a-f0-9-]+.*is not running/i.test(message)
    || /交互式工作区会话不存在/.test(message)
    || /Interactive session not found/i.test(message)
  );
}

/**
 * 功能：处理实验环境 页面。
 * 输入：无显式输入参数。
 * 输出：返回 React 元素，供父组件渲染。
 * 调用关系：由 React 组件树或路由渲染过程调用；内部调用 `useParams()`、`useNavigate()`、`useAuth()`、`useState()`、`useRef()`、`useEffect()`。
 */
export function LabPage() {
  // LabPage 是一个偏运行态页面：
  // 左边终端 / shell，右边 noVNC 图形显示，持续轮询后端状态。
  const { runId } = useParams();
  const navigate = useNavigate();
  const { token, user } = useAuth();
  const [session, setSession] = useState<QemuSession | null>(null);
  const [shells, setShells] = useState<QemuSession[]>([]);
  const [activeShellId, setActiveShellId] = useState<string | null>(null);
  const [maxWorkspaceShells, setMaxWorkspaceShells] = useState(DEFAULT_MAX_WORKSPACE_SHELLS);
  const [run, setRun] = useState<any | null>(null);
  const [workspaceLabel, setWorkspaceLabel] = useState("");
  const [pending, setPending] = useState<"start" | "stop" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [terminalMenu, setTerminalMenu] = useState<{ x: number; y: number; selection: string } | null>(null);
  const [appMenuOpen, setAppMenuOpen] = useState(false);
  const [labTheme, setLabTheme] = useState<LabTheme>(() =>
    window.localStorage.getItem(LAB_THEME_STORAGE_KEY) === "light" ? "light" : "dark"
  );
  const [vncAvailable, setVncAvailable] = useState(false);
  const [vncReconnectKey, setVncReconnectKey] = useState(0);
  const [vncStatus, setVncStatus] = useState<VncViewState>({
    phase: "idle",
    message: "请启动或选择一个正在运行的实验会话。",
    attempts: 0,
  });
  const [terminalPaneRatio, setTerminalPaneRatio] = useState(() => {
    const stored = Number(window.localStorage.getItem(LAB_SPLIT_STORAGE_KEY));
    return Number.isFinite(stored) && stored >= MIN_TERMINAL_PANE_RATIO && stored <= MAX_TERMINAL_PANE_RATIO
      ? stored
      : DEFAULT_TERMINAL_PANE_RATIO;
  });
  const labMainRef = useRef<HTMLElement | null>(null);
  const terminalHostRef = useRef<HTMLDivElement | null>(null);
  const vncHostRef = useRef<HTMLDivElement | null>(null);
  const xtermRef = useRef<Terminal | null>(null);
  const terminalSocketRef = useRef<WebSocket | null>(null);
  const terminalOutputRef = useRef("");
  const sessionRef = useRef<QemuSession | null>(null);
  const activeShellIdRef = useRef<string | null>(null);
  const inputQueueRef = useRef("");
  const inputSendingRef = useRef(false);
  const inputTimerRef = useRef<number | null>(null);
  const resizeTimerRef = useRef<number | null>(null);
  const vncRetryTimerRef = useRef<number | null>(null);
  const workspaceShellStartedRef = useRef(false);
  const workspaceLabInitializationRef = useRef<{ token: string; promise: Promise<void> } | null>(null);
  const splitResizeRef = useRef<{ pointerId: number } | null>(null);
  const running = session?.status === "running";
  const selectedSessionId = runId || activeShellId || session?.runId || null;

  function recoverFromTransientLabError(message: string) {
    if (!isStaleLabContainerMessage(message)) return false;
    setError(null);
    if (!runId) void loadSession();
    return true;
  }

  useEffect(() => {
    // 页面进入后持续刷新运行态，runId 存在时表示查看某个 Agent Run 的 QEMU。
    if (!token) return;
    workspaceShellStartedRef.current = false;
    const initialization = runId
      ? Promise.all([loadRun(), loadSession()]).then(() => undefined)
      : initializeWorkspaceLab(token);
    void initialization.catch(() => undefined);
    const timer = window.setInterval(
      () => void initialization.then(() => loadSession()).catch(() => undefined),
      1500,
    );
    return () => window.clearInterval(timer);
  }, [token, runId]);

  useEffect(() => {
    sessionRef.current = session;
  }, [session]);

  useEffect(() => {
    activeShellIdRef.current = activeShellId;
  }, [activeShellId]);

  useEffect(() => {
    window.localStorage.setItem(LAB_SPLIT_STORAGE_KEY, String(terminalPaneRatio));
  }, [terminalPaneRatio]);

  useEffect(() => {
    window.localStorage.setItem(LAB_THEME_STORAGE_KEY, labTheme);
    if (xtermRef.current) xtermRef.current.options.theme = TERMINAL_THEMES[labTheme];
  }, [labTheme]);

  useEffect(() => {
    const finishResize = (event?: PointerEvent) => {
      const resize = splitResizeRef.current;
      if (!resize || (event && event.pointerId !== resize.pointerId)) return;
      splitResizeRef.current = null;
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
    const resize = (event: PointerEvent) => {
      if (splitResizeRef.current?.pointerId !== event.pointerId) return;
      const main = labMainRef.current;
      if (!main) return;
      const bounds = main.getBoundingClientRect();
      const styles = window.getComputedStyle(main);
      const paddingLeft = Number.parseFloat(styles.paddingLeft) || 0;
      const paddingRight = Number.parseFloat(styles.paddingRight) || 0;
      const columnGap = Number.parseFloat(styles.columnGap) || 0;
      const dividerWidth = 10;
      const available = bounds.width - paddingLeft - paddingRight - (columnGap * 2) - dividerWidth;
      if (available <= 0) return;
      const desiredTerminalWidth = event.clientX - bounds.left - paddingLeft - columnGap - (dividerWidth / 2);
      const minimum = Math.max(MIN_TERMINAL_PANE_RATIO, Math.min(0.5, 360 / available));
      const maximum = Math.min(MAX_TERMINAL_PANE_RATIO, Math.max(0.5, 1 - (300 / available)));
      setTerminalPaneRatio(Math.min(maximum, Math.max(minimum, desiredTerminalWidth / available)));
    };

    window.addEventListener("pointermove", resize);
    window.addEventListener("pointerup", finishResize);
    window.addEventListener("pointercancel", finishResize);
    return () => {
      window.removeEventListener("pointermove", resize);
      window.removeEventListener("pointerup", finishResize);
      window.removeEventListener("pointercancel", finishResize);
      finishResize();
    };
  }, []);

  useEffect(() => {
    /**
     * 功能：关闭`menu`。
     * 输入：无显式输入参数。
     * 输出：返回该操作的完成状态；同步处理无结果时返回 void，异步处理返回 Promise。
     * 调用关系：由本模块其他函数、应用编排层、协议适配层或测试按需调用；内部调用 `setTerminalMenu()`。
     */
    const closeMenu = () => {
      setTerminalMenu(null);
      setAppMenuOpen(false);
    };
    window.addEventListener("pointerdown", closeMenu);
    return () => window.removeEventListener("pointerdown", closeMenu);
  }, []);

  useEffect(() => {
    // xterm 终端实例在这里创建，并把输入/resize 同步回后端。
    const host = terminalHostRef.current;
    if (!host) return;

    const terminal = new Terminal({
      cursorBlink: true,
      fontFamily: '"Cascadia Mono", "JetBrains Mono", "Noto Sans Mono CJK SC", "Noto Sans CJK SC", "Microsoft YaHei Mono", monospace',
      fontSize: 13,
      lineHeight: 1.35,
      theme: TERMINAL_THEMES[labTheme]
    });
    const fitAddon = new FitAddon();
    terminal.loadAddon(fitAddon);
    terminal.open(host);
    xtermRef.current = terminal;

    /**
     * 功能：处理`fit`。
     * 输入：无显式输入参数。
     * 输出：返回该操作生成、查询或转换后的结果；异步实现以 Promise 交付结果。
     * 调用关系：由 `apps/web/src/features/lab/LabPage.tsx:fit()` 调用；内部调用 `fit()`。
     */
    const fit = () => {
      try { fitAddon.fit(); } catch { /* The host may be temporarily hidden while the Lab opens. */ }
    };
    const frame = window.requestAnimationFrame(fit);
    const observer = new ResizeObserver(fit);
    observer.observe(host);
    const inputSubscription = terminal.onData((data) => queueTerminalInput(data));
    const resizeSubscription = terminal.onResize(({ cols, rows }) => queueTerminalResize(cols, rows));
    /**
     * 功能：复制`selection`。
     * 输入：`event`（MouseEvent）提供event。
     * 输出：返回该操作生成、查询或转换后的结果；异步实现以 Promise 交付结果。
     * 调用关系：由本模块其他函数、应用编排层、协议适配层或测试按需调用；内部调用 `getSelection()`、`preventDefault()`、`setTerminalMenu()`。
     */
    const copySelection = (event: MouseEvent) => {
      const selection = terminal.getSelection();
      event.preventDefault();
      setTerminalMenu({ x: event.clientX, y: event.clientY, selection });
    };
    host.addEventListener("contextmenu", copySelection);

    return () => {
      window.cancelAnimationFrame(frame);
      observer.disconnect();
      inputSubscription.dispose();
      resizeSubscription.dispose();
      host.removeEventListener("contextmenu", copySelection);
      terminal.dispose();
      xtermRef.current = null;
      terminalOutputRef.current = "";
      if (inputTimerRef.current !== null) window.clearTimeout(inputTimerRef.current);
      if (resizeTimerRef.current !== null) window.clearTimeout(resizeTimerRef.current);
    };
  }, [token, runId, activeShellId]);

  useEffect(() => {
    const terminal = xtermRef.current;
    if (!terminal) return;
    const output = session?.output || (pending === "start" || !session ? "正在启动工作区终端...\r\n" : "工作区终端已停止。请重新加载实验页面以打开新终端。\r\n");
    const previous = terminalOutputRef.current;
    if (!output.startsWith(previous)) {
      terminal.reset();
      terminalOutputRef.current = "";
    }
    const nextOutput = output.slice(terminalOutputRef.current.length);
    if (nextOutput) terminal.write(nextOutput);
    terminalOutputRef.current = output;
  }, [session?.output, session?.status, pending]);

  useEffect(() => {
    const sessionId = selectedSessionId;
    if (!token || !sessionId || !running) return;

    let disposed = false;
    let retryTimer: number | null = null;
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const url = `${protocol}//${window.location.host}/api/workspace/lab/terminal?token=${encodeURIComponent(token)}&sessionId=${encodeURIComponent(sessionId)}`;

    const connect = () => {
      if (disposed) return;
      const socket = new WebSocket(url);
      terminalSocketRef.current = socket;
      socket.addEventListener("message", (message) => {
        let event: TerminalServerEvent;
        try {
          event = JSON.parse(String(message.data)) as TerminalServerEvent;
        } catch {
          return;
        }

        if (event.type === "snapshot") {
          const terminal = xtermRef.current;
          terminal?.reset();
          if (event.session.output) terminal?.write(event.session.output);
          terminalOutputRef.current = event.session.output;
          setSession((current) => current?.runId === sessionId ? event.session : current);
        } else if (event.type === "output") {
          xtermRef.current?.write(event.data);
          terminalOutputRef.current += event.data;
        } else if (event.type === "status") {
          setSession((current) => current?.runId === sessionId ? event.session : current);
        } else if (event.type === "resized") {
          setError((current) => current === "工作区终端尚未就绪。" ? null : current);
        } else if (event.type === "error") {
          if (recoverFromTransientLabError(event.message)) return;
          setError(event.message);
        }
      });
      socket.addEventListener("close", () => {
        if (terminalSocketRef.current === socket) terminalSocketRef.current = null;
        if (!disposed) retryTimer = window.setTimeout(connect, 750);
      });
    };

    connect();
    return () => {
      disposed = true;
      if (retryTimer !== null) window.clearTimeout(retryTimer);
      const socket = terminalSocketRef.current;
      terminalSocketRef.current = null;
      socket?.close();
    };
  }, [token, selectedSessionId, running]);

  useEffect(() => {
    const sessionId = selectedSessionId;
    if (!token || !running || !sessionId) {
      setVncAvailable(false);
      setVncStatus({ phase: "idle", message: "请启动或选择一个正在运行的实验会话。", attempts: 0 });
      return;
    }

    let disposed = false;
    let timer: number | null = null;
    const probe = async () => {
      try {
        const data = await apiFetch<{ status: VncProbeStatus }>(
          `/workspace/lab/vnc-status?sessionId=${encodeURIComponent(sessionId)}`,
          { token },
        );
        if (disposed) return;
        const available = data.status.state === "available";
        setVncAvailable(available);
        setVncStatus((current) => {
          if (available) {
            if (current.phase === "displaying" || current.phase === "connecting") return current;
            return { phase: "connecting", message: data.status.message, attempts: current.attempts };
          }
          return {
            phase: data.status.state === "session_stopped" ? "idle" : "waiting",
            message: data.status.message,
            attempts: current.attempts,
          };
        });
        if (!available) timer = window.setTimeout(probe, 900);
      } catch (probeError) {
        if (disposed) return;
        setVncAvailable(false);
        setVncStatus((current) => ({
          phase: "error",
          message: probeError instanceof Error ? probeError.message : "无法检查 VNC 端点。",
          attempts: current.attempts,
        }));
        timer = window.setTimeout(probe, 2000);
      }
    };

    setVncStatus({ phase: "checking", message: "正在检查实验运行环境和 QEMU VNC 监听器。", attempts: 0 });
    void probe();
    return () => {
      disposed = true;
      if (timer !== null) window.clearTimeout(timer);
    };
  }, [token, running, selectedSessionId, vncReconnectKey]);

  useEffect(() => {
    return () => {
      if (vncRetryTimerRef.current !== null) {
        window.clearTimeout(vncRetryTimerRef.current);
        vncRetryTimerRef.current = null;
      }
    };
  }, [selectedSessionId]);

  useEffect(() => {
    // noVNC 连接和重连逻辑。
    const host = vncHostRef.current;
    const sessionId = selectedSessionId;
    if (!host || !token || !running || !sessionId || !vncAvailable) return;

    let disposed = false;
    let rfb: RFB | null = null;
    let retryTimer: number | null = null;
    let attempts = 0;
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const url = `${protocol}//${window.location.host}/api/workspace/lab/vnc?token=${encodeURIComponent(token)}&sessionId=${encodeURIComponent(sessionId)}`;

    /**
     * 功能：处理`connect`。
     * 输入：无显式输入参数。
     * 输出：返回该操作生成、查询或转换后的结果；异步实现以 Promise 交付结果。
     * 调用关系：由 `apps/web/src/features/lab/LabPage.tsx:LabPage()` 调用；内部调用 `replaceChildren()`、`addEventListener()`、`setVncStatus()`、`setTimeout()`。
     */
    const connect = () => {
      if (disposed) return;
      attempts += 1;
      setVncStatus({
        phase: "connecting",
        message: "VNC 端点已可用，正在协商 RFB 显示会话。",
        attempts,
      });
      host.replaceChildren();
      let client: RFB;
      try {
        client = new RFB(host, url, { shared: true });
      } catch (connectionError) {
        setVncStatus({
          phase: "error",
          message: connectionError instanceof Error ? connectionError.message : "无法创建 noVNC 客户端。",
          attempts,
        });
        retryTimer = window.setTimeout(connect, 1000);
        return;
      }
      rfb = client;
      client.scaleViewport = true;
      client.background = labTheme === "light" ? "#f3f6f5" : "#080b0a";
      client.addEventListener("connect", () => {
        if (rfb !== client) return;
        const canvas = host.querySelector("canvas");
        const dimensions = canvas?.width && canvas?.height ? `${canvas.width} x ${canvas.height}` : undefined;
        setVncStatus({
          phase: "displaying",
          message: dimensions ? `已连接 QEMU 帧缓冲区，尺寸为 ${dimensions}。` : "已连接 QEMU 帧缓冲区。",
          attempts,
          dimensions,
        });
      });
      client.addEventListener("securityfailure", () => {
        if (rfb === client) setVncStatus({ phase: "error", message: "RFB 安全握手失败。", attempts });
      });
      client.addEventListener("credentialsrequired", () => {
        if (rfb === client) setVncStatus({ phase: "error", message: "QEMU VNC 服务意外要求提供凭据。", attempts });
      });
      client.addEventListener("disconnect", (event) => {
        if (disposed || rfb !== client) return;
        const clean = Boolean((event as CustomEvent<{ clean?: boolean }>).detail?.clean);
        setVncStatus({
          phase: "disconnected",
          message: clean ? "QEMU VNC 服务已关闭显示连接。" : "VNC 连接中断，正在自动重试。",
          attempts,
        });
        setVncAvailable(false);
        if (vncRetryTimerRef.current !== null) window.clearTimeout(vncRetryTimerRef.current);
        vncRetryTimerRef.current = window.setTimeout(() => {
          vncRetryTimerRef.current = null;
          setVncReconnectKey((current) => current + 1);
        }, 1000);
      });
    };

    connect();
    return () => {
      disposed = true;
      if (retryTimer !== null) window.clearTimeout(retryTimer);
      try { rfb?.disconnect(); } catch { /* Connection may not have completed yet. */ }
      host.replaceChildren();
    };
  }, [token, running, selectedSessionId, labTheme, vncAvailable, vncReconnectKey]);

  /**
   * 功能：加载运行。
   * 输入：无显式输入参数。
   * 输出：返回该操作生成、查询或转换后的结果；异步实现以 Promise 交付结果。
   * 调用关系：由 `apps/web/src/features/lab/LabPage.tsx:LabPage()` 调用；内部调用 `apiFetch()`、`setRun()`。
   */
  async function loadRun() {
    if (!token || !runId) return;
    const data = await apiFetch<{ run: any }>(`/agent/runs/${runId}`, { token });
    setRun(data.run);
  }

  /** 普通 OS Lab 每次真正进入页面时只复位一次；同一挂载内的 Strict Mode 重放复用该 Promise。 */
  function initializeWorkspaceLab(currentToken: string) {
    const current = workspaceLabInitializationRef.current;
    if (current?.token === currentToken) return current.promise;

    setShells([]);
    setActiveShellId(null);
    setSession(null);
    setError(null);
    const promise = apiFetch<{ session: QemuSession; workspace: { workspaceUuid: string }; limits: { maxShells: number } }>("/workspace/lab/reset", {
      method: "POST",
      token: currentToken,
      headers: { "X-Lab-Client-Revision": LAB_BUILD_REVISION },
    }).then((data) => {
      workspaceShellStartedRef.current = true;
      setWorkspaceLabel(data.workspace.workspaceUuid.slice(0, 10));
      setMaxWorkspaceShells(data.limits.maxShells);
      setShells([data.session]);
      setActiveShellId(data.session.runId);
      setSession(data.session);
    }).catch((resetError) => {
      const message = messageFromError(resetError, "无法重置操作系统实验环境。");
      if (!recoverFromTransientLabError(message)) setError(message);
      throw resetError;
    });
    workspaceLabInitializationRef.current = { token: currentToken, promise };
    return promise;
  }

  /**
   * 功能：复制`terminal` `selection`。
   * 输入：`selection`（string）提供selection。
   * 输出：返回该操作生成、查询或转换后的结果；异步实现以 Promise 交付结果。
   * 调用关系：由 `apps/web/src/features/lab/LabPage.tsx:LabPage()` 调用；内部调用 `writeText()`、`createElement()`、`append()`、`select()`、`execCommand()`、`remove()`。
   */
  async function copyTerminalSelection(selection: string) {
    try {
      await navigator.clipboard.writeText(selection);
      return;
    } catch {
      const helper = document.createElement("textarea");
      helper.value = selection;
      helper.style.position = "fixed";
      helper.style.opacity = "0";
      document.body.append(helper);
      helper.select();
      document.execCommand("copy");
      helper.remove();
    }
  }

  /**
   * 功能：加载会话。
   * 输入：无显式输入参数。
   * 输出：返回该操作生成、查询或转换后的结果；异步实现以 Promise 交付结果。
   * 调用关系：由 `apps/web/src/features/lab/LabPage.tsx:LabPage()`、`apps/web/src/features/lab/LabPage.tsx:flushTerminalInput()` 调用；内部调用 `apiFetch()`、`setShells()`、`setWorkspaceLabel()`、`find()`、`setActiveShellId()`、`setSession()`。
   */
  async function loadSession() {
    // workspace Lab 与 run 级 QEMU session 共用一个页面，但数据来源不同。
    if (!token) return;
    try {
      if (!runId) {
        const data = await apiFetch<{ session: QemuSession; shells: QemuSession[]; workspace: { workspaceUuid: string }; limits: { maxShells: number } }>("/workspace/lab", { token });
        setShells(data.shells);
        setWorkspaceLabel(data.workspace.workspaceUuid.slice(0, 10));
        setMaxWorkspaceShells(data.limits.maxShells);
        const selected = data.shells.find((shell) => shell.runId === activeShellIdRef.current)
          ?? data.shells.find((shell) => shell.status === "running")
          ?? data.shells[0];
        if (selected) {
          setActiveShellId(selected.runId);
          setSession(selected);
        } else {
          setActiveShellId(null);
          setSession(null);
          if (!workspaceShellStartedRef.current) {
            workspaceShellStartedRef.current = true;
            void createShell();
          }
        }
        return;
      }
      const data = await apiFetch<{ session: QemuSession }>(`/agent/runs/${runId}/qemu-session`, { token });
      setSession(data.session);
    } catch (loadError) {
      const message = messageFromError(loadError, "无法加载 QEMU 会话。");
      if (!recoverFromTransientLabError(message)) setError(message);
    }
  }

  /**
   * 功能：创建终端会话。
   * 输入：无显式输入参数。
   * 输出：返回该操作生成、查询或转换后的结果；异步实现以 Promise 交付结果。
   * 调用关系：由 `apps/web/src/features/lab/LabPage.tsx:loadSession()`、`apps/web/src/features/lab/LabPage.tsx:closeShell()`、`apps/web/src/features/lab/LabPage.tsx:LabPage()` 调用；内部调用 `setPending()`、`setError()`、`apiFetch()`、`setShells()`、`setActiveShellId()`、`setSession()`。
   */
  async function createShell() {
    if (!token || runId) return;
    setPending("start");
    setError(null);
    try {
      const data = await apiFetch<{ session: QemuSession }>("/workspace/lab/shells", { method: "POST", token });
      setShells((current) => [...current, data.session]);
      setActiveShellId(data.session.runId);
      setSession(data.session);
    } catch (createError) {
      const message = messageFromError(createError, "无法创建工作区终端。");
      if (!recoverFromTransientLabError(message)) setError(message);
    } finally {
      setPending(null);
    }
  }

  /**
   * 功能：关闭终端会话。
   * 输入：`sessionId`（string）提供会话 id。
   * 输出：返回该操作的完成状态；同步处理无结果时返回 void，异步处理返回 Promise。
   * 调用关系：由 `apps/web/src/features/lab/LabPage.tsx:LabPage()` 调用；内部调用 `apiFetch()`、`encodeURIComponent()`、`setShells()`、`find()`、`setActiveShellId()`、`setSession()`。
   */
  async function closeShell(sessionId: string) {
    if (!token || runId) return;
    await apiFetch(`/workspace/lab/shells/${encodeURIComponent(sessionId)}`, { method: "DELETE", token });
    const remaining = shells.filter((shell) => shell.runId !== sessionId);
    setShells(remaining);
    if (activeShellId === sessionId) {
      const next = remaining.find((shell) => shell.status === "running") ?? remaining[0] ?? null;
      setActiveShellId(next?.runId ?? null);
      setSession(next);
      if (!next) void createShell();
    }
  }

  /**
   * 功能：选择终端会话。
   * 输入：`next`（QemuSession）提供next。
   * 输出：返回该操作生成、查询或转换后的结果；异步实现以 Promise 交付结果。
   * 调用关系：由 `apps/web/src/features/lab/LabPage.tsx:LabPage()` 调用；内部调用 `setActiveShellId()`、`setSession()`。
   */
  function selectShell(next: QemuSession) {
    setActiveShellId(next.runId);
    setSession(next);
  }

  /**
   * 功能：启动`start` 对应的数据。
   * 输入：无显式输入参数。
   * 输出：返回该操作生成、查询或转换后的结果；异步实现以 Promise 交付结果。
   * 调用关系：由 `apps/web/src/features/lab/LabPage.tsx:LabPage()` 调用；内部调用 `setPending()`、`setError()`、`apiFetch()`、`setSession()`。
   */
  async function start() {
    if (!token) return;
    setPending("start");
    setError(null);
    try {
      const endpoint = runId ? `/agent/runs/${runId}/qemu-session/start` : "/workspace/lab/start";
      const data = await apiFetch<{ session: QemuSession }>(endpoint, { method: "POST", token });
      setSession(data.session);
    } catch (startError) {
      const message = messageFromError(startError, "无法启动 QEMU。");
      if (!recoverFromTransientLabError(message)) setError(message);
    } finally {
      setPending(null);
    }
  }

  /**
   * 功能：停止`stop` 对应的数据。
   * 输入：无显式输入参数。
   * 输出：返回该操作的完成状态；同步处理无结果时返回 void，异步处理返回 Promise。
   * 调用关系：由本模块其他函数、应用编排层、协议适配层或测试按需调用；内部调用 `setPending()`、`apiFetch()`、`setSession()`。
   */
  async function stop() {
    if (!token) return;
    setPending("stop");
    try {
      const endpoint = runId ? `/agent/runs/${runId}/qemu-session/stop` : "/workspace/lab/stop";
      const data = await apiFetch<{ session: QemuSession }>(endpoint, { method: "POST", token });
      setSession(data.session);
    } finally {
      setPending(null);
    }
  }

  /**
   * 功能：立即写出`terminal` 结构化输入。
   * 输入：无显式输入参数。
   * 输出：返回该操作生成、查询或转换后的结果；异步实现以 Promise 交付结果。
   * 调用关系：由 `apps/web/src/features/lab/LabPage.tsx:flushTerminalInput()`、`apps/web/src/features/lab/LabPage.tsx:queueTerminalInput()` 调用；内部调用 `encodeURIComponent()`、`apiFetch()`、`stringify()`、`loadSession()`、`setError()`、`flushTerminalInput()`。
   */
  async function flushTerminalInput() {
    if (!token || inputSendingRef.current || sessionRef.current?.status !== "running") return;
    inputSendingRef.current = true;
    const endpoint = runId
      ? `/agent/runs/${runId}/qemu-session/input`
      : `/workspace/lab/shells/${encodeURIComponent(activeShellIdRef.current || "")}/input`;
    try {
      while (inputQueueRef.current && sessionRef.current?.status === "running") {
        const input = inputQueueRef.current;
        inputQueueRef.current = "";
        await apiFetch(endpoint, { method: "POST", token, body: JSON.stringify({ input }) });
      }
      void loadSession();
    } catch (inputError) {
      const message = messageFromError(inputError, "无法发送终端输入。");
      if (!recoverFromTransientLabError(message)) setError(message);
    } finally {
      inputSendingRef.current = false;
      if (inputQueueRef.current) void flushTerminalInput();
    }
  }

  /**
   * 功能：处理`queue` `terminal` 结构化输入。
   * 输入：`data`（string）提供data。
   * 输出：返回该操作生成、查询或转换后的结果；异步实现以 Promise 交付结果。
   * 调用关系：由 `apps/web/src/features/lab/LabPage.tsx:LabPage()` 调用；内部调用 `setTimeout()`、`flushTerminalInput()`。
   */
  function queueTerminalInput(data: string) {
    if (sessionRef.current?.status !== "running") return;
    const socket = terminalSocketRef.current;
    if (socket?.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({ type: "input", data }));
      return;
    }
    inputQueueRef.current += data;
    if (inputTimerRef.current !== null) return;
    inputTimerRef.current = window.setTimeout(() => {
      inputTimerRef.current = null;
      void flushTerminalInput();
    }, 12);
  }

  /**
   * 功能：处理`queue` `terminal` `resize`。
   * 输入：`columns`（number）提供columns。 `rows`（number）提供rows。
   * 输出：返回该操作生成、查询或转换后的结果；异步实现以 Promise 交付结果。
   * 调用关系：由 `apps/web/src/features/lab/LabPage.tsx:LabPage()` 调用；内部调用 `clearTimeout()`、`setTimeout()`、`catch()`、`apiFetch()`、`encodeURIComponent()`、`stringify()`。
   */
  function queueTerminalResize(columns: number, rows: number) {
    if (!token || runId || !activeShellIdRef.current || sessionRef.current?.status !== "running") return;
    if (resizeTimerRef.current !== null) window.clearTimeout(resizeTimerRef.current);
    resizeTimerRef.current = window.setTimeout(() => {
      resizeTimerRef.current = null;
      const sessionId = activeShellIdRef.current;
      if (!sessionId) return;
      const socket = terminalSocketRef.current;
      if (socket?.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ type: "resize", columns, rows }));
        return;
      }
      void apiFetch(`/workspace/lab/shells/${encodeURIComponent(sessionId)}/resize`, {
        method: "POST",
        token,
        body: JSON.stringify({ columns, rows })
      }).then(() => {
        setError((current) => current === "工作区终端尚未就绪。" ? null : current);
      }).catch((resizeError) => {
        const message = messageFromError(resizeError, "无法调整工作区终端大小。");
        if (recoverFromTransientLabError(message)) return;
        setError(message);
      });
    }, 75);
  }

  const buildReady = runId ? run?.buildRuns?.[0]?.status === "success" : true;

  return (
    <div className={`lab-shell ${labTheme}`}>
      <header className="lab-header">
        <div className="lab-header-left">
          <button className="lab-back" title="返回工作区" aria-label="返回工作区" onClick={() => navigate("/app")}>←</button>
          <div className="lab-app-menu-wrap" onPointerDown={(event) => event.stopPropagation()}>
            <button className={`lab-brand ${appMenuOpen ? "open" : ""}`} onClick={() => setAppMenuOpen((open) => !open)} aria-expanded={appMenuOpen}>
              <span className="lab-logo">OS</span>
              <span className="lab-brand-copy"><strong>操作系统实验工作区</strong><small>{user?.email} · {runId?.slice(0, 10) || workspaceLabel || "工作区"}</small></span>
              <Icon name="chevron" size={13} />
            </button>
            {appMenuOpen ? <div className="lab-app-menu">
              <div className="lab-menu-label">外观</div>
              {(["light", "dark"] as LabTheme[]).map((theme) => <button
                key={theme}
                className={labTheme === theme ? "active" : ""}
                onClick={() => { setLabTheme(theme); setAppMenuOpen(false); }}
              >
                <Icon name="theme" size={15} />
                <span><strong>{theme === "light" ? "浅色" : "深色"}</strong><small>{theme === "light" ? "明亮界面" : "暗色界面"}</small></span>
                <i />
              </button>)}
            </div> : null}
          </div>
        </div>
        <div className="lab-controls">
          <span className={`lab-status ${running ? "running" : ""}`}><i />{session ? SESSION_STATUS_LABELS[session.status] : "空闲"}</span>
          {runId ? <button disabled={!buildReady || running || pending === "start"} onClick={() => void start()}>{pending === "start" ? "正在启动..." : "启动 QEMU"}</button> : null}
        </div>
      </header>
      <main
        className="lab-main"
        ref={labMainRef}
        style={{
          "--lab-terminal-size": `${terminalPaneRatio}fr`,
          "--lab-display-size": `${1 - terminalPaneRatio}fr`,
        } as CSSProperties}
      >
        <section className="lab-terminal-card">
          <div className="lab-terminal-title">
            <div className="putty-icon">›_</div>
            <div className="lab-shell-tabs">
              {(runId ? (session ? [session] : []) : shells).map((shell, index) => <button
                key={shell.runId}
                className={shell.runId === (activeShellId || session?.runId) ? "active" : ""}
                onClick={() => selectShell(shell)}
              >
                <i className={shell.status === "running" ? "running" : ""} />
                Bash {index + 1}
                {!runId ? <span onClick={(event) => { event.stopPropagation(); void closeShell(shell.runId); }}>×</span> : null}
              </button>)}
              {!runId ? <button className="lab-new-shell" disabled={pending === "start" || shells.filter((shell) => shell.status === "running").length >= maxWorkspaceShells} onClick={() => void createShell()} title="新建 Bash">+</button> : null}
            </div>
            <small>/home/runner/project</small>
          </div>
          <div className="lab-terminal" ref={terminalHostRef} />
        </section>
        <div
          className="lab-resize-handle"
          role="separator"
          aria-label="调整 Bash 与图形显示区域的大小"
          aria-orientation="vertical"
          aria-valuemin={Math.round(MIN_TERMINAL_PANE_RATIO * 100)}
          aria-valuemax={Math.round(MAX_TERMINAL_PANE_RATIO * 100)}
          aria-valuenow={Math.round(terminalPaneRatio * 100)}
          tabIndex={0}
          title="拖动以调整 Bash 与图形显示区域的大小"
          onDoubleClick={() => setTerminalPaneRatio(DEFAULT_TERMINAL_PANE_RATIO)}
          onPointerDown={(event) => {
            event.preventDefault();
            splitResizeRef.current = { pointerId: event.pointerId };
            document.body.style.cursor = "col-resize";
            document.body.style.userSelect = "none";
          }}
          onKeyDown={(event) => {
            if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
            event.preventDefault();
            const direction = event.key === "ArrowLeft" ? -1 : 1;
            setTerminalPaneRatio((current) => Math.min(
              MAX_TERMINAL_PANE_RATIO,
              Math.max(MIN_TERMINAL_PANE_RATIO, current + (direction * 0.03)),
            ));
          }}
        />
        <aside className="lab-display-card">
          <div className="lab-display-title"><span>图形显示</span><small>noVNC</small></div>
          <div className="lab-display">
            <div className="lab-vnc-host" ref={vncHostRef} />
            {vncStatus.phase !== "displaying" ? <div className="lab-display-placeholder">
              <div className="display-grid" />
              <span className="display-chip">VNC</span>
              <h2>{VNC_PHASE_LABELS[vncStatus.phase]}</h2>
              <p>{vncStatus.message}</p>
            </div> : null}
          </div>
          <div className="lab-metadata">
            <span className={`lab-vnc-state ${vncStatus.phase}`}><i /><strong>{VNC_PHASE_LABELS[vncStatus.phase]}</strong></span>
            <span className="lab-vnc-detail">{vncStatus.dimensions ? `帧缓冲区 ${vncStatus.dimensions}` : vncStatus.message}</span>
            {vncStatus.attempts > 1 ? <span className="lab-vnc-attempts">第 {vncStatus.attempts} 次尝试</span> : null}
            <button
              className="lab-vnc-reconnect"
              disabled={!running}
              title="重新连接 VNC"
              aria-label="重新连接 VNC"
              onClick={() => {
                if (vncRetryTimerRef.current !== null) window.clearTimeout(vncRetryTimerRef.current);
                vncRetryTimerRef.current = null;
                setVncAvailable(false);
                setVncReconnectKey((current) => current + 1);
              }}
            ><Icon name="refresh" size={14} /></button>
          </div>
        </aside>
      </main>
      {error ? <div className="lab-error">{error}</div> : null}
      {terminalMenu ? <div className="lab-context-menu" style={{ left: terminalMenu.x, top: terminalMenu.y }} onPointerDown={(event) => event.stopPropagation()}>
        <button disabled={!terminalMenu.selection} onClick={() => { void copyTerminalSelection(terminalMenu.selection); setTerminalMenu(null); }}>复制</button>
      </div> : null}
    </div>
  );
}
