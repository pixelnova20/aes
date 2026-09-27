/**
 * 文件作用：实现前端“工作台”功能模块的 React 界面与交互。
 * 模块位置：`apps/web/src/features/workspace/WorkspaceEditor.tsx`，属于前端“工作台”功能模块。
 * 重要函数：`WorkspaceEditor()` 负责处理工作区 `editor`；`WelcomeEditor()` 负责处理`welcome` `editor`。
 */
import { memo } from "react";
import type { RefObject } from "react";
import Editor from "@monaco-editor/react";
import type { editor, Position } from "monaco-editor";

import { apiFetch } from "../../shared/api/client";
import { FileIcon, Icon } from "./workspace-icons";
import type { OpenFile, WorkbenchTheme } from "./workspace-types";
import { languageFromPath } from "./workspace-utils";

/**
 * 功能：处理工作区 `editor`。
 * 输入：`props`（{ token: string; theme: WorkbenchTheme; currentFile: OpenFile | null; openFiles: OpenFile[]; activeFile: string | null; ）提供props。
 * 输出：返回 React 元素，供父组件渲染。
 * 调用关系：由 React 组件树或路由渲染过程调用；内部调用 `onActiveFileChange()`、`pop()`、`split()`、`stopPropagation()`、`onCloseFile()`、`languageFromPath()`。
 */
export const WorkspaceEditor = memo(function WorkspaceEditor(props: {
  token: string;
  theme: WorkbenchTheme;
  currentFile: OpenFile | null;
  openFiles: OpenFile[];
  activeFile: string | null;
  editorRef: RefObject<editor.IStandaloneCodeEditor | null>;
  onActiveFileChange: (path: string) => void;
  onCloseFile: (path: string) => void;
  onContentChange: (content: string | undefined) => void;
  onOpenFile: (path: string) => void;
  onOpenAssistant: () => void;
  readOnly?: boolean;
  rootLabel?: string;
}) {
  return (
    <main className="wb-editor-area">
      <div className="wb-editor-actions">
        <div className="wb-breadcrumb">
          <Icon name="branch" size={13} />
          <span>{props.rootLabel ?? "main"}</span>
          {props.currentFile ? (
            <><Icon name="chevronRight" size={12} /><span>{props.currentFile.path}</span></>
          ) : null}
        </div>
      </div>
      <div className="wb-tabs">
        {props.openFiles.map((file) => (
          <button
            className={`wb-tab ${props.activeFile === file.path ? "active" : ""}`}
            key={file.path}
            onClick={() => props.onActiveFileChange(file.path)}
          >
            <FileIcon path={file.path} />
            <span>{file.path.split("/").pop()}</span>
            {file.dirty ? <i /> : null}
            <span
              className="wb-tab-close"
              onClick={(event) => {
                event.stopPropagation();
                props.onCloseFile(file.path);
              }}
            ><Icon name="close" size={12} /></span>
          </button>
        ))}
      </div>
      <div className="wb-editor">
        {props.currentFile ? (
          <Editor
            height="100%"
            path={props.currentFile.path}
            language={languageFromPath(props.currentFile.path)}
            value={props.currentFile.content}
            onChange={props.readOnly ? undefined : props.onContentChange}
            theme={props.theme === "light" ? "vs" : "aios-dark"}
            onMount={(mountedEditor, monaco) => {
              props.editorRef.current = mountedEditor;
              monaco.languages.registerDefinitionProvider("*", {
                                /**
                                 * 功能：处理`provide` 定义。
                                 * 输入：`model`（editor.ITextModel）提供模型。 `position`（Position）提供position。
                                 * 输出：返回该操作生成、查询或转换后的结果；异步实现以 Promise 交付结果。
                                 * 调用关系：由本模块其他函数、应用编排层、协议适配层或测试按需调用；内部调用 `getWordAtPosition()`、`replace()`、`apiFetch()`、`encodeURIComponent()`、`setTimeout()`、`onOpenFile()`。
                                 */
                                async provideDefinition(model: editor.ITextModel, position: Position) {
                  const word = model.getWordAtPosition(position);
                  if (!word) return [];
                  const filePath = (model.uri.path ?? "").replace(/^\//, "");
                  try {
                    const result = await apiFetch<{
                      definitions: Array<{
                        file: string;
                        line: number;
                        kind: string;
                        name: string;
                      }>;
                    }>(
                      `/workspace/code-nav/definition?file=${encodeURIComponent(filePath)}&word=${encodeURIComponent(word.word)}`,
                      { token: props.token },
                    );
                    const definition = result.definitions[0];
                    if (!definition) return [];
                    window.setTimeout(() => {
                      props.onOpenFile(definition.file);
                      window.setTimeout(() => {
                        const activeEditor = props.editorRef.current;
                        activeEditor?.revealLineInCenter(definition.line);
                        activeEditor?.setPosition({ lineNumber: definition.line, column: 1 });
                      }, 300);
                    }, 0);
                  } catch {
                    return [];
                  }
                  return [];
                },
              });
              monaco.editor.defineTheme("aios-dark", {
                base: "vs-dark",
                inherit: true,
                rules: [],
                colors: {
                  "editor.background": "#181818",
                  "editor.lineHighlightBackground": "#202020",
                  "editorGutter.background": "#181818",
                },
              });
              monaco.editor.setTheme(props.theme === "light" ? "vs" : "aios-dark");
            }}
            options={{
              automaticLayout: true,
              fontFamily: "'JetBrains Mono', 'Cascadia Code', monospace",
              fontSize: 13,
              lineHeight: 21,
              minimap: { enabled: true, scale: 1 },
              padding: { top: 12 },
              scrollBeyondLastLine: false,
              renderLineHighlight: "all",
              readOnly: props.readOnly ?? false,
              domReadOnly: props.readOnly ?? false,
            }}
          />
        ) : (
          <WelcomeEditor onOpenAssistant={props.onOpenAssistant} readOnly={props.readOnly} />
        )}
      </div>
    </main>
  );
});

/**
 * 功能：处理`welcome` `editor`。
 * 输入：`{ onOpenAssistant }`（{ onOpenAssistant: () => void }）提供{ on open 助手消息 }。
 * 输出：返回 React 元素，供父组件渲染。
 * 调用关系：由 React 组件树或路由渲染过程调用。
 */
function WelcomeEditor({ onOpenAssistant, readOnly = false }: { onOpenAssistant: () => void; readOnly?: boolean }) {
  return (
    <div className="wb-welcome">
      <div className="wb-welcome-logo">{readOnly ? "C" : "A"}</div>
      <h1>{readOnly ? "Courseworks 审阅" : "AES"}</h1>
      <p>{readOnly ? "从左侧选择学生文件，以只读方式查看工程和开发记录。" : "在隔离的 AI 辅助工作区中完成课程工程。"}</p>
      <div className="wb-welcome-grid">
        <button onClick={onOpenAssistant}>
          <Icon name="spark" size={17} />
          <span><strong>{readOnly ? "审核 AI" : "AI 助手"}</strong><small>{readOnly ? "总结学生工程和实验过程" : "规划或实现操作系统功能"}</small></span>
        </button>
      </div>
      <div className="wb-shortcuts">
        {readOnly ? <span>学生文件只读，不会复制或修改</span> : <span><kbd>Ctrl</kbd> + <kbd>S</kbd> 保存文件</span>}
        <span><kbd>Enter</kbd> 发送 · <kbd>Shift</kbd> + <kbd>Enter</kbd> 换行</span>
      </div>
    </div>
  );
}
