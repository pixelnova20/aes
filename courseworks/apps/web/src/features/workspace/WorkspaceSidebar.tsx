/**
 * 文件作用：实现前端“工作台”功能模块的 React 界面与交互。
 * 模块位置：`apps/web/src/features/workspace/WorkspaceSidebar.tsx`，属于前端“工作台”功能模块。
 * 重要函数：`FileTree()` 负责处理文件 目录树；`WorkspaceSidebar()` 负责处理工作区 `sidebar`。
 */
import { memo } from "react";
import type { Dispatch, FormEvent, SetStateAction } from "react";

import type { FileNode } from "../../shared/types";
import { FileIcon, Icon } from "./workspace-icons";
import type { ViewKey } from "./workspace-types";
import { compact, statusTone, viewTitle } from "./workspace-utils";

type RunListItem = {
  id: string;
  status: string;
  taskSummary?: string | null;
  prompt?: string | null;
};
type ClassProgress = {
  classes: Array<{
    id: string;
    code: string;
    className: string | null;
    students: Array<{
      id: string;
      email: string;
      workspaceStatus: string;
      aiProviderConfigured: boolean;
    }>;
  }>;
};

const STATUS_LABELS: Record<string, string> = {
  idle: "空闲",
  pending: "等待中",
  initializing: "初始化中",
  ready: "就绪",
  running: "运行中",
  completed: "已完成",
  success: "成功",
  passed: "通过",
  failed: "失败",
  error: "错误",
  cancelled: "已取消",
};

function statusLabel(status: string) {
  return STATUS_LABELS[status] ?? status;
}

/**
 * 功能：处理文件 目录树。
 * 输入：`props`（{ nodes: FileNode[]; depth?: number; activeFile: string | null; collapsedDirectories: Set<string>; setCollapsedDirectori）提供props。
 * 输出：返回 React 元素，供父组件渲染。
 * 调用关系：由 React 组件树或路由渲染过程调用；内部调用 `has()`、`setCollapsedDirectories()`、`delete()`、`add()`、`onOpenFile()`。
 */
const FileTree = memo(function FileTreeComponent(props: {
  nodes: FileNode[];
  depth?: number;
  activeFile: string | null;
  collapsedDirectories: Set<string>;
  setCollapsedDirectories: Dispatch<SetStateAction<Set<string>>>;
  onOpenFile: (path: string) => void;
}) {
  const depth = props.depth ?? 0;
  return props.nodes.map((node) => {
    const collapsed = node.type === "directory"
      && props.collapsedDirectories.has(node.path);
    return (
      <div key={node.path}>
        {node.type === "directory" ? (
          <>
            <button
              type="button"
              className="wb-tree-row folder"
              style={{ paddingLeft: 10 + depth * 14 }}
              aria-expanded={!collapsed}
              onClick={() => props.setCollapsedDirectories((directories) => {
                const next = new Set(directories);
                if (next.has(node.path)) next.delete(node.path);
                else next.add(node.path);
                return next;
              })}
            >
              {node.children?.length ? (
                <Icon name={collapsed ? "chevronRight" : "chevron"} size={13} />
              ) : (
                <span className="wb-tree-indent-spacer" aria-hidden="true" />
              )}
              <Icon name="folder" size={15} />
              <span>{node.name}</span>
            </button>
            {!collapsed && node.children ? (
              <FileTree {...props} nodes={node.children} depth={depth + 1} />
            ) : null}
          </>
        ) : (
          <button
            type="button"
            className={`wb-tree-row file ${props.activeFile === node.path ? "selected" : ""}`}
            style={{ paddingLeft: 10 + depth * 14 }}
            onClick={() => props.onOpenFile(node.path)}
          >
            <span className="wb-tree-indent-spacer" aria-hidden="true" />
            <FileIcon path={node.path} />
            <span>{node.name}</span>
          </button>
        )}
      </div>
    );
  });
});

/**
 * 功能：处理工作区 `sidebar`。
 * 输入：`props`（{ width: number; activeView: ViewKey; tree: FileNode[]; activeFile: string | null; createEntry: "file" | "directory" | n）提供props。
 * 输出：返回 React 元素，供父组件渲染。
 * 调用关系：由 React 组件树或路由渲染过程调用；内部调用 `viewTitle()`、`onCreateEntryChange()`、`onCreatePathChange()`、`onOpenRun()`、`statusTone()`、`compact()`。
 */
export const WorkspaceSidebar = memo(function WorkspaceSidebar(props: {
  width: number;
  activeView: ViewKey;
  tree: FileNode[];
  activeFile: string | null;
  createEntry: "file" | "directory" | null;
  createPath: string;
  collapsedDirectories: Set<string>;
  setCollapsedDirectories: Dispatch<SetStateAction<Set<string>>>;
  agentRuns: RunListItem[];
  currentRunId?: string;
  classProgress: ClassProgress | null;
  onClose: () => void;
  onCreateEntryChange: (value: "file" | "directory" | null) => void;
  onCreatePathChange: (value: string) => void;
  onCreateEntry: (event: FormEvent) => void;
  onOpenFile: (path: string) => void;
  onOpenRun: (runId: string) => void;
  readOnly?: boolean;
}) {
  return (
    <aside className="wb-sidebar" style={{ flexBasis: props.width }}>
      <div className="wb-sidebar-title">
        <span>{props.readOnly && props.activeView === "explorer" ? "审阅" : viewTitle(props.activeView)}</span>
        <div className="wb-sidebar-actions">
          {props.activeView === "explorer" && !props.readOnly ? (
            <>
              <button
                title="新建文件"
                onClick={() => {
                  props.onCreateEntryChange("file");
                  props.onCreatePathChange("");
                }}
              ><Icon name="filePlus" size={14} /></button>
              <button
                title="新建文件夹"
                onClick={() => {
                  props.onCreateEntryChange("directory");
                  props.onCreatePathChange("");
                }}
              ><Icon name="folderPlus" size={14} /></button>
            </>
          ) : null}
          <button title="关闭侧栏" onClick={props.onClose}>
            <Icon name="close" size={14} />
          </button>
        </div>
      </div>
      {props.activeView === "explorer" ? (
        <>
          <div className="wb-section-heading"><Icon name="chevron" size={12} /> {props.readOnly ? "学生工作区" : "工程"}</div>
          {props.createEntry && !props.readOnly ? (
            <form className="wb-create-entry" onSubmit={props.onCreateEntry}>
              <Icon name={props.createEntry === "file" ? "filePlus" : "folderPlus"} size={14} />
              <input
                autoFocus
                value={props.createPath}
                placeholder={props.createEntry === "file" ? "例如：src/main.c" : "例如：src"}
                onChange={(event) => props.onCreatePathChange(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Escape") {
                    props.onCreateEntryChange(null);
                    props.onCreatePathChange("");
                  }
                }}
              />
            </form>
          ) : null}
          <div className="wb-tree">
            <FileTree
              nodes={props.tree}
              activeFile={props.activeFile}
              collapsedDirectories={props.collapsedDirectories}
              setCollapsedDirectories={props.setCollapsedDirectories}
              onOpenFile={props.onOpenFile}
            />
          </div>
        </>
      ) : null}
      {props.activeView === "runs" ? (
        <div className="wb-runs-list">
          {props.agentRuns.map((run) => (
            <button
              className={`wb-run-item ${props.currentRunId === run.id ? "active" : ""}`}
              key={run.id}
              onClick={() => props.onOpenRun(run.id)}
            >
              <span className={`wb-run-status ${statusTone(run.status)}`} />
              <span>
                <strong>{compact(run.taskSummary || run.prompt || "Agent 运行", 32)}</strong>
                <small>{statusLabel(run.status)}</small>
              </span>
            </button>
          ))}
          {!props.agentRuns.length ? <p className="wb-empty-copy">暂无运行记录。</p> : null}
        </div>
      ) : null}
      {props.activeView === "class" ? (
        <div className="wb-sidebar-content">
          {props.classProgress?.classes.map((classItem) => (
            <section key={classItem.id}>
              <p className="wb-muted">{classItem.className || classItem.code}</p>
              {classItem.students.map((student) => (
                <div className="wb-student-row" key={student.id}>
                  <span>{student.email.slice(0, 1).toUpperCase()}</span>
                  <div>
                    <strong>{student.email}</strong>
                    <small>
                      {statusLabel(student.workspaceStatus)} · {student.aiProviderConfigured ? "AI 已配置" : "未配置 AI"}
                    </small>
                  </div>
                </div>
              ))}
              {!classItem.students.length ? <p className="wb-empty-copy">暂无学生。</p> : null}
            </section>
          ))}
          {!props.classProgress?.classes.length ? <p className="wb-empty-copy">暂无可用班级。</p> : null}
        </div>
      ) : null}
    </aside>
  );
});
