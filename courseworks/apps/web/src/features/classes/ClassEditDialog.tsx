import { FormEvent, useEffect } from "react";

import { Icon } from "../workspace/workspace-icons";

export type EditableClass = {
  id: string;
  courseName: string | null;
  className: string | null;
  capacity: number;
  memberCount: number;
};

export type ClassEditValues = {
  className: string;
  capacity: number;
};

export function ClassEditDialog({
  classItem,
  busy,
  error,
  onClose,
  onSubmit,
}: {
  classItem: EditableClass;
  busy: boolean;
  error: string | null;
  onClose: () => void;
  onSubmit: (values: ClassEditValues) => Promise<void>;
}) {
  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !busy) onClose();
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [busy, onClose]);

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const values = new FormData(event.currentTarget);
    void onSubmit({
      className: String(values.get("className") || "").trim(),
      capacity: Number(values.get("capacity")),
    });
  }

  return (
    <div className="class-modal-backdrop" onMouseDown={() => { if (!busy) onClose(); }}>
      <form
        aria-labelledby="edit-class-title"
        aria-modal="true"
        className="class-create-dialog"
        onMouseDown={(event) => event.stopPropagation()}
        onSubmit={submit}
        role="dialog"
      >
        <div className="class-dialog-header">
          <div><span>班级管理</span><h2 id="edit-class-title">编辑班级</h2></div>
          <button aria-label="关闭编辑班级窗口" className="class-dialog-close" disabled={busy} onClick={onClose} title="关闭" type="button">
            <Icon name="close" size={17} />
          </button>
        </div>
        <div className="class-dialog-context">
          <small>所属课程</small>
          <strong>{classItem.courseName || "未命名课程"}</strong>
        </div>
        <div className="class-create-form">
          <label>班级名称<input autoFocus defaultValue={classItem.className || ""} maxLength={191} name="className" required /></label>
          <label>
            人数上限
            <input
              defaultValue={classItem.capacity}
              min={Math.max(1, classItem.memberCount)}
              max="10000"
              name="capacity"
              type="number"
              required
            />
          </label>
        </div>
        <p className="class-dialog-hint">当前班级有 {classItem.memberCount} 名成员。</p>
        {error ? <div className="form-error">{error}</div> : null}
        <div className="class-dialog-actions">
          <button className="ghost-button" disabled={busy} onClick={onClose} type="button">取消</button>
          <button className="primary-button" disabled={busy} type="submit">{busy ? "保存中..." : "保存"}</button>
        </div>
      </form>
    </div>
  );
}
