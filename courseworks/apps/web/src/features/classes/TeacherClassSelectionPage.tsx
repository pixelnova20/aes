import { FormEvent, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";

import { apiFetch } from "../../shared/api/client";
import { useAuth } from "../auth/auth-context";
import { Icon } from "../workspace/workspace-icons";
import { ClassEditDialog, type ClassEditValues } from "./ClassEditDialog";

type TeacherClass = {
  id: string;
  code: string;
  courseName: string | null;
  className: string | null;
  capacity: number;
  memberCount: number;
  isActive: boolean;
  isCurrent: boolean;
};

export function TeacherClassSelectionPage() {
  const navigate = useNavigate();
  const { token, setSession, refreshUser } = useAuth();
  const [classes, setClasses] = useState<TeacherClass[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [switchingId, setSwitchingId] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editingClass, setEditingClass] = useState<TeacherClass | null>(null);
  const [editError, setEditError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  async function loadClasses() {
    if (!token) return;
    try {
      const data = await apiFetch<{ classes: TeacherClass[] }>("/teacher/classes", { token });
      setClasses(data.classes);
      setError(null);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "无法加载班级列表。");
    } finally {
      setLoaded(true);
    }
  }

  useEffect(() => {
    void loadClasses();
  }, [token]);

  useEffect(() => {
    if (!createOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !creating) setCreateOpen(false);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [createOpen, creating]);

  async function createClass(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!token) return;
    const form = event.currentTarget;
    const values = new FormData(form);
    setCreating(true);
    setCreateError(null);
    setMessage(null);
    try {
      const data = await apiFetch<{ class: TeacherClass }>("/teacher/classes", {
        method: "POST",
        token,
        body: JSON.stringify({
          courseName: String(values.get("courseName") || ""),
          className: String(values.get("className") || ""),
          capacity: Number(values.get("capacity") || 50),
        }),
      });
      form.reset();
      setCreateOpen(false);
      await Promise.all([loadClasses(), refreshUser()]);
      setMessage(`班级创建成功，已切换到该班级。学生邀请码：${data.class.code}`);
    } catch (createFailure) {
      setCreateError(createFailure instanceof Error ? createFailure.message : "创建班级失败。");
    } finally {
      setCreating(false);
    }
  }

  function openCreateDialog() {
    setCreateError(null);
    setMessage(null);
    setCreateOpen(true);
  }

  async function selectClass(item: TeacherClass) {
    if (!token || item.isCurrent || !item.isActive || switchingId) return;
    setSwitchingId(item.id);
    setMessage(null);
    setError(null);
    try {
      const session = await apiFetch<{
        token: string;
        user: Parameters<typeof setSession>[1];
      }>(`/teacher/classes/${item.id}/select`, { method: "POST", token });
      setSession(session.token, session.user);
      setClasses((current) => current.map((entry) => ({
        ...entry,
        isCurrent: entry.id === item.id,
      })));
      setMessage(`已切换到 ${item.courseName || "课程"} / ${item.className || "班级"}。`);
    } catch (switchError) {
      setError(switchError instanceof Error ? switchError.message : "切换班级失败。");
    } finally {
      setSwitchingId(null);
    }
  }

  async function updateClass(values: ClassEditValues) {
    if (!token || !editingClass) return;
    setSaving(true);
    setEditError(null);
    try {
      const data = await apiFetch<{ class: TeacherClass }>(
        `/teacher/classes/${editingClass.id}`,
        {
          method: "PATCH",
          token,
          body: JSON.stringify(values),
        },
      );
      setClasses((current) => current.map((item) => (
        item.id === data.class.id ? data.class : item
      )));
      if (data.class.isCurrent) await refreshUser();
      setMessage(`班级“${data.class.className || "未命名班级"}”已更新。`);
      setEditingClass(null);
    } catch (updateError) {
      setEditError(updateError instanceof Error ? updateError.message : "更新班级失败。");
    } finally {
      setSaving(false);
    }
  }

  async function deleteClass(item: TeacherClass) {
    if (!token || deletingId) return;
    if (!window.confirm(`确认删除 ${item.courseName} / ${item.className} 吗？该班级及其成员数据将先归档，此操作无法撤销。`)) return;
    setDeletingId(item.id);
    setMessage(null);
    setError(null);
    try {
      const result = await apiFetch<{ archiveDirectory: string }>(
        `/teacher/classes/${item.id}`,
        { method: "DELETE", token },
      );
      await Promise.all([loadClasses(), refreshUser()]);
      setMessage(`班级已删除。归档目录：${result.archiveDirectory}`);
    } catch (deleteError) {
      setError(deleteError instanceof Error ? `删除班级失败：${deleteError.message}` : "删除班级失败。");
    } finally {
      setDeletingId(null);
    }
  }

  return (
    <main className="classes-shell classes-shell-teacher student-classes-shell">
      <header className="classes-header">
        <button className="icon-button" onClick={() => navigate("/portal")} title="返回服务门户" type="button">
          <Icon name="arrow" size={18} />
        </button>
        <div><span>教师班级</span><h1>选择工作班级</h1></div>
        <button
          className="primary-button classes-create-button"
          disabled={creating || deletingId !== null || switchingId !== null}
          onClick={openCreateDialog}
          type="button"
        >
          <Icon name="folderPlus" size={17} />
          新建班级
        </button>
      </header>

      {message ? <div className="notice success">{message}</div> : null}
      {error ? <div className="form-error student-classes-message">{error}</div> : null}

      <section className="student-class-list-panel teacher-class-selection">
        <div className="student-class-list-heading">
          <h2>我管理的班级</h2>
          <span>{classes.length}</span>
        </div>
        {!loaded ? <p className="empty-state">正在加载班级...</p> : null}
        {loaded && !classes.length ? <p className="empty-state">尚未创建班级。</p> : null}
        {classes.map((item) => (
          <article className="student-class-row" key={item.id}>
            <div className="student-class-main">
              <div className="student-class-title">
                <strong>{item.className || "未命名班级"}</strong>
                {item.isCurrent ? <span>当前班级</span> : null}
                {!item.isActive ? <span className="ta">已停用</span> : null}
              </div>
              <p>{item.courseName || "未命名课程"}</p>
              <small>{item.memberCount} 名成员 · <code>{item.code}</code></small>
            </div>
            <div className="student-class-actions">
              <button
                className="ghost-button compact"
                disabled={switchingId !== null || deletingId !== null}
                onClick={() => { setEditError(null); setEditingClass(item); }}
                type="button"
              >
                <Icon name="edit" size={15} /> 编辑
              </button>
              {!item.isCurrent ? (
                <button
                  className="ghost-button compact"
                  disabled={!item.isActive || switchingId !== null || deletingId !== null}
                  onClick={() => void selectClass(item)}
                  type="button"
                >
                  {switchingId === item.id ? "正在切换..." : "切换到此班级"}
                </button>
              ) : null}
              <button
                className="danger-button compact"
                disabled={switchingId !== null || deletingId !== null}
                onClick={() => void deleteClass(item)}
                type="button"
              >
                <Icon name="trash" size={15} />
                {deletingId === item.id ? "正在删除..." : "删除"}
              </button>
            </div>
          </article>
        ))}
      </section>
      {createOpen ? (
        <div
          aria-modal="true"
          className="class-modal-backdrop"
          onMouseDown={(event) => {
            if (event.currentTarget === event.target && !creating) setCreateOpen(false);
          }}
          role="dialog"
        >
          <form className="class-create-dialog" onSubmit={createClass}>
            <div className="class-dialog-header">
              <div>
                <span className="classes-eyebrow">教师班级</span>
                <h2>新建班级</h2>
              </div>
              <button
                aria-label="关闭"
                className="class-dialog-close"
                disabled={creating}
                onClick={() => setCreateOpen(false)}
                type="button"
              >
                <Icon name="close" size={20} />
              </button>
            </div>
            <div className="class-create-form">
              <label>
                课程名称
                <input autoFocus name="courseName" required />
              </label>
              <label>
                班级名称
                <input name="className" required />
              </label>
              <label>
                人数上限
                <input defaultValue="50" max="10000" min="1" name="capacity" required type="number" />
              </label>
            </div>
            <p className="class-dialog-hint">创建后将自动生成一个以教师一级邀请码开头的班级邀请码。</p>
            {createError ? <p className="classes-error">{createError}</p> : null}
            <div className="class-dialog-actions">
              <button className="secondary-button" disabled={creating} onClick={() => setCreateOpen(false)} type="button">
                取消
              </button>
              <button className="primary-button" disabled={creating} type="submit">
                {creating ? "创建中..." : "创建班级"}
              </button>
            </div>
          </form>
        </div>
      ) : null}
      {editingClass ? (
        <ClassEditDialog
          busy={saving}
          classItem={editingClass}
          error={editError}
          onClose={() => { if (!saving) setEditingClass(null); }}
          onSubmit={updateClass}
        />
      ) : null}
    </main>
  );
}
