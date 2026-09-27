/**
 * 文件作用：实现前端“工作台”功能模块中的 `Icon`、`FileIcon`、`ActivityButton` 等能力。
 * 模块位置：`apps/web/src/features/workspace/workspace-icons.tsx`，属于前端“工作台”功能模块。
 * 重要函数：`Icon()` 负责处理`icon`；`FileIcon()` 负责处理文件 `icon`；`ActivityButton()` 负责处理活动记录 `button`。
 */
import type { ReactNode } from "react";

export type IconName = "files" | "spark" | "history" | "users" | "settings"
  | "account" | "search" | "close" | "chevron" | "chevronRight" | "folder"
  | "branch" | "tools" | "play" | "panel" | "send" | "stop" | "arrow"
  | "screen" | "theme" | "filePlus" | "folderPlus" | "more" | "refresh"
  | "homeworks" | "plus" | "edit" | "trash" | "check" | "key";

/**
 * 功能：处理`icon`。
 * 输入：`{ name, size = 16 }`（{ name: IconName; size?: number }）提供{ name, size = 16 }。
 * 输出：返回 React 元素，供父组件渲染。
 * 调用关系：由 React 组件树或路由渲染过程调用。
 */
export function Icon({ name, size = 16 }: { name: IconName; size?: number }) {
  const paths: Record<IconName, ReactNode> = {
    files: <><path d="M5 3h9l5 5v13H5z" /><path d="M14 3v5h5M2 7v14h12" /></>,
    spark: <><path d="m12 3 1.6 4.4L18 9l-4.4 1.6L12 15l-1.6-4.4L6 9l4.4-1.6z" /><path d="m18.5 15 .8 2.2 2.2.8-2.2.8-.8 2.2-.8-2.2-2.2-.8 2.2-.8z" /></>,
    history: <><path d="M3 12a9 9 0 1 0 3-6.7L3 8" /><path d="M3 3v5h5M12 7v5l3 2" /></>,
    users: <><circle cx="9" cy="8" r="3" /><path d="M3 20v-2a5 5 0 0 1 5-5h2a5 5 0 0 1 5 5v2M16 5a3 3 0 0 1 0 6M17 14a5 5 0 0 1 4 4v2" /></>,
    settings: <><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1-2.8 2.8-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.6v.2h-4V21a1.7 1.7 0 0 0-1-1.6 1.7 1.7 0 0 0-1.9.3l-.1.1L4.2 17l.1-.1a1.7 1.7 0 0 0 .3-1.9A1.7 1.7 0 0 0 3 14H3v-4h.1a1.7 1.7 0 0 0 1.5-1 1.7 1.7 0 0 0-.3-1.9L4.2 7 7 4.2l.1.1A1.7 1.7 0 0 0 9 4.6a1.7 1.7 0 0 0 1-1.6V3h4v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.9-.3l.1-.1L19.8 7l-.1.1a1.7 1.7 0 0 0-.3 1.9 1.7 1.7 0 0 0 1.6 1h.2v4H21a1.7 1.7 0 0 0-1.6 1z" /></>,
    account: <><circle cx="12" cy="8" r="4" /><path d="M4 21a8 8 0 0 1 16 0" /></>,
    search: <><circle cx="11" cy="11" r="7" /><path d="m20 20-4-4" /></>,
    close: <path d="m7 7 10 10M17 7 7 17" />,
    chevron: <path d="m8 10 4 4 4-4" />,
    chevronRight: <path d="m10 8 4 4-4 4" />,
    folder: <path d="M3 6h7l2 2h9v11H3z" />,
    branch: <><circle cx="6" cy="4" r="2" /><circle cx="18" cy="6" r="2" /><circle cx="6" cy="20" r="2" /><path d="M6 6v12M8 8c5 0 4-2 8-2" /></>,
    tools: <><path d="m14 7 3-3 3 3-3 3zM4 20l8-8M4 15l5 5" /></>,
    play: <path d="m8 5 11 7-11 7z" />,
    panel: <><rect x="3" y="4" width="18" height="16" rx="1" /><path d="M3 15h18" /></>,
    send: <><path d="m22 2-7 20-4-9-9-4z" /><path d="M22 2 11 13" /></>,
    stop: <rect x="6" y="6" width="12" height="12" rx="1" fill="currentColor" stroke="none" />,
    arrow: <path d="M5 12h14M14 7l5 5-5 5" />,
    screen: <><rect x="3" y="4" width="18" height="14" rx="1" /><path d="M8 22h8M12 18v4" /></>,
    theme: <><path d="M12 3a9 9 0 1 0 9 9c0-1.1-.9-2-2-2h-2.2a1.8 1.8 0 0 1-1.8-1.8c0-1 .8-1.8 1.8-1.8h.7A2.5 2.5 0 0 0 12 3Z" /><circle cx="7.5" cy="11" r=".7" fill="currentColor" /><circle cx="10" cy="7.5" r=".7" fill="currentColor" /></>,
    filePlus: <><path d="M5 3h9l5 5v13H5z" /><path d="M14 3v5h5M9 14h6M12 11v6" /></>,
    folderPlus: <><path d="M3 6h7l2 2h9v11H3z" /><path d="M9 14h6M12 11v6" /></>,
    more: <><circle cx="5" cy="12" r="1" fill="currentColor" stroke="none" /><circle cx="12" cy="12" r="1" fill="currentColor" stroke="none" /><circle cx="19" cy="12" r="1" fill="currentColor" stroke="none" /></>,
    refresh: <><path d="M20 7v5h-5" /><path d="M4 17v-5h5" /><path d="M6.1 8.2A7 7 0 0 1 18.8 10M5.2 14A7 7 0 0 0 17.9 15.8" /></>,
    homeworks: <><path d="M5 4h10l4 4v12H5z" /><path d="M15 4v4h4M8 12h8M8 16h6" /></>,
    plus: <path d="M12 5v14M5 12h14" />,
    edit: <><path d="M4 20h4L19 9l-4-4L4 16z" /><path d="m13 7 4 4" /></>,
    trash: <><path d="M4 7h16M9 7V4h6v3M7 7l1 13h8l1-13" /><path d="M10 11v5M14 11v5" /></>,
    check: <path d="m5 12 4 4L19 6" />,
    key: <><circle cx="8" cy="15" r="4" /><path d="m11 12 8-8M15 8l3 3M17 6l2 2" /></>,
  };
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name]}</svg>;
}

/**
 * 功能：处理文件 `icon`。
 * 输入：`{ path }`（{ path: string }）提供{ 路径 }。
 * 输出：返回 React 元素，供父组件渲染。
 * 调用关系：由 React 组件树或路由渲染过程调用；内部调用 `endsWith()`。
 */
export function FileIcon({ path }: { path: string }) {
  const color = path.endsWith(".c") || path.endsWith(".h")
    ? "#519aba"
    : path.endsWith(".json")
      ? "#f0c35a"
      : path.endsWith(".md") ? "#60a5fa" : "#b8b8b8";
  const label = path.endsWith(".h") ? "h" : path.endsWith(".c") ? "c" : "◇";
  return <span className="wb-file-icon" style={{ color }}>{label}</span>;
}

/**
 * 功能：处理活动记录 `button`。
 * 输入：`props`（{ active?: boolean; label: string; icon: IconName; onClick: () => void; }）提供props。
 * 输出：返回 React 元素，供父组件渲染。
 * 调用关系：由 React 组件树或路由渲染过程调用。
 */
export function ActivityButton(props: {
  active?: boolean;
  label: string;
  icon: IconName;
  onClick: () => void;
}) {
  return <button className={props.active ? "active" : ""} title={props.label} onClick={props.onClick}><Icon name={props.icon} size={23} /></button>;
}
