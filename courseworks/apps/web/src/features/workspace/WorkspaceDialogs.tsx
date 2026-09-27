/**
 * 文件作用：实现前端“工作台”功能模块中的 `SettingsDialog`、`WorkspaceImportDialog` 等能力。
 * 模块位置：`apps/web/src/features/workspace/WorkspaceDialogs.tsx`，属于前端“工作台”功能模块。
 * 重要函数：`SettingsDialog()` 负责处理设置 `dialog`；`WorkspaceImportDialog()` 负责处理工作区 `import` `dialog`。
 */
import { useEffect } from "react";
import type { Dispatch, FormEvent, RefObject, SetStateAction } from "react";

import { Icon } from "./workspace-icons";
import type { AiProviderForm, ReasoningEffort, WorkspaceImportSummary } from "./workspace-types";
import { formatUploadSize } from "./workspace-utils";

export const REASONING_EFFORT_LABELS: Record<ReasoningEffort, string> = {
  default: "默认",
  minimal: "最低",
  low: "低",
  medium: "中",
  high: "高",
  xhigh: "很高",
  max: "最高",
};

/**
 * 功能：处理设置 `dialog`。
 * 输入：`props`（{ form: AiProviderForm; setForm: Dispatch<SetStateAction<AiProviderForm>>; modelProfileHint: string | null; providerMode）提供props。
 * 输出：返回 React 元素，供父组件渲染。
 * 调用关系：由 React 组件树或路由渲染过程调用；内部调用 `stopPropagation()`、`setForm()`、`onModelChanged()`、`onModelSelected()`、`includes()`、`onContextWindowTouched()`。
 */
export function SettingsDialog(props: {
  form: AiProviderForm;
  setForm: Dispatch<SetStateAction<AiProviderForm>>;
  apiKeyConfigured: boolean;
  apiKeyMasked: string;
  modelProfileHint: string | null;
  providerModels: string[];
  reasoningEffortOptions: ReasoningEffort[];
  modelDiscoveryMessage: string | null;
  discoveringModels: boolean;
  message: string | null;
  testing: boolean;
  saving: boolean;
  dirty: boolean;
  onModelChanged: () => void;
  onModelSelected: (model: string) => void;
  onModelBlur: () => void;
  onContextWindowTouched: () => void;
  onClose: () => void;
  onSave: (event: FormEvent<HTMLFormElement>) => void;
  onTest: () => void;
}) {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || props.saving) return;
      event.preventDefault();
      props.onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [props.onClose, props.saving]);

  return (
    <div
      className="wb-modal-backdrop"
      onMouseDown={() => {
        if (!props.saving) props.onClose();
      }}
    >
      <form
        className="wb-settings-dialog"
        onSubmit={props.onSave}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="wb-dialog-header">
          <div><p className="eyebrow">设置</p><h2>AI 服务商</h2></div>
          <button
            type="button"
            aria-label="取消服务商设置更改"
            title="取消"
            disabled={props.saving}
            onClick={props.onClose}
          >
            <Icon name="close" size={16} />
          </button>
        </div>
        <p className="wb-muted">配置编程 Agent 使用的 AI 服务商。</p>
        <section className="wb-settings-section">
          <h3>连接</h3>
          <label>
            Base URL
            <input required value={props.form.baseUrl} onChange={(event) => props.setForm((value) => ({ ...value, baseUrl: event.target.value }))} />
          </label>
          <label>
            API Key
            <input
              type="password"
              autoComplete="new-password"
              spellCheck={false}
              value={props.form.apiKey}
              placeholder={props.apiKeyConfigured ? props.apiKeyMasked : "输入 API Key"}
              onChange={(event) => props.setForm((value) => ({ ...value, apiKey: event.target.value }))}
            />
          </label>
        </section>
        <section className="wb-settings-section">
          <h3>模型</h3>
          <label>
            模型名称
            {props.providerModels.length > 0 ? (
              <select
                required
                value={props.form.model}
                onChange={(event) => {
                  const model = event.target.value;
                  props.onModelChanged();
                  props.setForm((value) => ({ ...value, model }));
                  if (model) props.onModelSelected(model);
                }}
              >
                <option value="">选择模型</option>
                {props.form.model && !props.providerModels.includes(props.form.model)
                  ? <option value={props.form.model}>{props.form.model}（当前）</option>
                  : null}
                {props.providerModels.map((model) => <option key={model} value={model}>{model}</option>)}
              </select>
            ) : (
              <input
                required
                value={props.form.model}
                placeholder="provider/model"
                onBlur={props.onModelBlur}
                onChange={(event) => {
                  props.onModelChanged();
                  props.setForm((value) => ({ ...value, model: event.target.value }));
                }}
              />
            )}
          </label>
          <label>
            推理强度
            <select
              value={props.form.reasoningEffort}
              disabled={props.reasoningEffortOptions.length === 1}
              onChange={(event) => props.setForm((value) => ({
                ...value,
                reasoningEffort: event.target.value as ReasoningEffort,
              }))}
            >
              {props.reasoningEffortOptions.map((effort) => (
                <option key={effort} value={effort}>{REASONING_EFFORT_LABELS[effort]}</option>
              ))}
            </select>
          </label>
        </section>
        <details className="wb-settings-advanced">
          <summary>高级设置</summary>
          <div className="wb-form-grid">
            <label>温度<input type="number" min="0" max="2" step="0.1" value={props.form.temperature} onChange={(event) => props.setForm((value) => ({ ...value, temperature: event.target.value }))} /></label>
            <label>上下文窗口<input type="number" min="1" step="1" value={props.form.contextWindowTokens} onChange={(event) => { props.onContextWindowTouched(); props.setForm((value) => ({ ...value, contextWindowTokens: event.target.value })); }} /></label>
          </div>
        </details>
        {props.modelProfileHint ? <div className="wb-settings-hint">{props.modelProfileHint}</div> : null}
        {props.modelDiscoveryMessage ? <div className="wb-settings-hint">{props.discoveringModels ? "正在加载模型..." : props.modelDiscoveryMessage}</div> : null}
        {props.message ? <div className="wb-settings-message">{props.message}</div> : null}
        <div className="wb-dialog-actions wb-dialog-actions-split">
          <button type="button" className="wb-secondary" disabled={props.testing || props.saving} onClick={props.onTest}>{props.testing ? "正在测试..." : "测试连接"}</button>
          <div className="wb-dialog-actions-primary">
            <button type="button" className="wb-secondary" disabled={props.saving} onClick={props.onClose}>取消</button>
            <button className="wb-primary" type="submit" disabled={!props.dirty || props.testing || props.saving}>{props.saving ? "正在保存..." : "保存更改"}</button>
          </div>
        </div>
      </form>
    </div>
  );
}

/**
 * 功能：处理工作区 `import` `dialog`。
 * 输入：`props`（{ file: File | null; mode: "archive-only" | "extract"; overwritePolicy: "fail" | "merge" | "overwrite"; targetPath: stri）提供props。
 * 输出：返回 React 元素，供父组件渲染。
 * 调用关系：由 React 组件树或路由渲染过程调用；内部调用 `stopPropagation()`、`onPickFile()`、`onModeChange()`、`onOverwritePolicyChange()`、`onTargetPathChange()`、`formatUploadSize()`。
 */
export function WorkspaceImportDialog(props: {
  file: File | null;
  mode: "archive-only" | "extract";
  overwritePolicy: "fail" | "merge" | "overwrite";
  targetPath: string;
  importing: boolean;
  summary: WorkspaceImportSummary | null;
  error: string | null;
  fileInputRef: RefObject<HTMLInputElement | null>;
  onClose: () => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  onPickFile: (file: File | null) => void;
  onModeChange: (value: "archive-only" | "extract") => void;
  onOverwritePolicyChange: (value: "fail" | "merge" | "overwrite") => void;
  onTargetPathChange: (value: string) => void;
}) {
  return (
    <div className="wb-modal-backdrop" onMouseDown={props.onClose}>
      <form
        className="wb-settings-dialog wb-import-dialog"
        onSubmit={props.onSubmit}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="wb-dialog-header">
          <div><p className="eyebrow">工作区</p><h2>导入工作区</h2></div>
          <button type="button" onClick={props.onClose}><Icon name="close" size={16} /></button>
        </div>
        <p className="wb-muted">支持 `.zip`、`.tar.gz`、`.tgz`、`.tar.bz2`、`.tbz2`。这会写入当前工作区，但不会创建聊天消息、会话附件或 Agent 运行记录。</p>
        <label>
          压缩包
          <input
            ref={props.fileInputRef}
            type="file"
            accept=".zip,.tar.gz,.tgz,.tar.bz2,.tbz2"
            onChange={(event) => props.onPickFile(event.target.files?.[0] ?? null)}
          />
        </label>
        <div className="wb-form-grid">
          <label>
            导入方式
            <select value={props.mode} onChange={(event) => props.onModeChange(event.target.value as "archive-only" | "extract")}>
              <option value="extract">解压到工作区</option>
              <option value="archive-only">只保存压缩包</option>
            </select>
          </label>
          <label>
            冲突策略
            <select value={props.overwritePolicy} onChange={(event) => props.onOverwritePolicyChange(event.target.value as "fail" | "merge" | "overwrite")}>
              <option value="fail">不覆盖已有文件</option>
              <option value="merge">跳过冲突文件并导入其余文件</option>
              <option value="overwrite">覆盖已有文件</option>
            </select>
          </label>
          <label>目标目录<input value={props.targetPath} placeholder="/" onChange={(event) => props.onTargetPathChange(event.target.value)} /></label>
        </div>
        <div className="wb-settings-hint">可导入的压缩包格式：`.zip`、`.tar.gz`、`.tgz`、`.tar.bz2`、`.tbz2`。解压会向当前工作区写入文件，可能与已有文件冲突。</div>
        {props.file ? <div className="wb-settings-hint">当前文件：{props.file.name} ({formatUploadSize(props.file.size)})</div> : null}
        {props.error ? <div className="wb-settings-message">{props.error}</div> : null}
        {props.summary ? (
          <div className="wb-import-summary">
            <strong>导入完成</strong>
            <span>目标目录：{props.summary.targetPath}</span>
            <span>写入文件：{props.summary.writtenCount}</span>
            <span>跳过文件：{props.summary.skippedCount}</span>
            <span>冲突文件：{props.summary.conflictCount}</span>
            {props.summary.writtenFiles.length ? <pre>{props.summary.writtenFiles.slice(0, 20).join("\n")}</pre> : null}
          </div>
        ) : null}
        <div className="wb-dialog-actions">
          <button type="button" className="wb-secondary" onClick={props.onClose}>关闭</button>
          <button className="wb-primary" type="submit" disabled={!props.file || props.importing}>{props.importing ? "导入中..." : "开始导入"}</button>
        </div>
      </form>
    </div>
  );
}
