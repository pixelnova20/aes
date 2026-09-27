import { FormEvent, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";

import { apiFetch } from "../../shared/api/client";
import { useAuth } from "../auth/auth-context";
import { Icon } from "../workspace/workspace-icons";
import { ClassEditDialog, type ClassEditValues } from "./ClassEditDialog";

type ClassItem = {
  id: string;
  code: string;
  courseName: string | null;
  className: string | null;
  capacity: number;
  memberCount: number;
  isActive: boolean;
  isCurrent: boolean;
};

type Member = {
  id: string;
  email: string;
  name: string | null;
  studentNo: string | null;
  role: "student" | "ta";
  workspaceStatus: string;
  lastLoginAt: string | null;
};

export function ClassManagementPage() {
  const navigate = useNavigate();
  const { token, user, refreshUser } = useAuth();
  const [classes, setClasses] = useState<ClassItem[]>([]);
  const [classesLoaded, setClassesLoaded] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [members, setMembers] = useState<Member[]>([]);
  const [message, setMessage] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [editingClass, setEditingClass] = useState<ClassItem | null>(null);
  const [editError, setEditError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [deletingClassId, setDeletingClassId] = useState<string | null>(null);

  async function loadClasses(preferredId?: string) {
    if (!token) return;
    try {
      const data = await apiFetch<{ classes: ClassItem[] }>("/teacher/classes", { token });
      setClasses(data.classes);
      setSelectedId((current) => {
        if (preferredId && data.classes.some((item) => item.id === preferredId)) return preferredId;
        if (current && data.classes.some((item) => item.id === current)) return current;
        return data.classes.find((item) => item.isCurrent)?.id ?? data.classes[0]?.id ?? null;
      });
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "无法加载班级列表。");
    } finally {
      setClassesLoaded(true);
    }
  }

  async function loadMembers(classId: string) {
    if (!token) return;
    const data = await apiFetch<{ members: Member[] }>(`/teacher/classes/${classId}/members`, { token });
    setMembers(data.members);
  }

  useEffect(() => { void loadClasses(); }, [token]);
  useEffect(() => {
    if (selectedId) void loadMembers(selectedId);
    else setMembers([]);
  }, [selectedId, token]);

  async function createClass(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!token) return;
    const form = event.currentTarget;
    const values = new FormData(form);
    setCreating(true);
    setCreateError(null);
    try {
      const data = await apiFetch<{ class: ClassItem }>("/teacher/classes", {
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
      setMessage(`班级创建成功。学生邀请码：${data.class.code}`);
      await loadClasses(data.class.id);
    } catch (error) {
      setCreateError(error instanceof Error ? error.message : "创建班级失败。请稍后重试。");
    } finally {
      setCreating(false);
    }
  }

  useEffect(() => {
    if (!createOpen) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !creating) setCreateOpen(false);
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [createOpen, creating]);

  function openCreateDialog() {
    setCreateError(null);
    setCreateOpen(true);
  }

  async function changeRole(member: Member) {
    if (!token || !selectedId) return;
    const nextRole = member.role === "student" ? "ta" : "student";
    await apiFetch(`/teacher/classes/${selectedId}/members/${member.id}/role`, {
      method: "PATCH",
      token,
      body: JSON.stringify({ role: nextRole }),
    });
    setMessage(nextRole === "ta" ? "已将学生设为助教。" : "已将助教恢复为学生。");
    await loadMembers(selectedId);
  }

  async function deleteMember(member: Member) {
    if (!token || !selectedId) return;
    if (!window.confirm(`确认从当前班级删除 ${member.email} 吗？该账号在本班的相关数据将先归档。`)) return;
    const result = await apiFetch<{ archiveDirectory: string }>(
      `/teacher/classes/${selectedId}/members/${member.id}`,
      { method: "DELETE", token },
    );
    setMessage(`班级成员已删除。归档目录：${result.archiveDirectory}`);
    await Promise.all([loadMembers(selectedId), loadClasses(selectedId)]);
  }

  async function deleteClass(item: ClassItem) {
    if (!token || deletingClassId) return;
    if (!window.confirm(`确认删除 ${item.courseName} / ${item.className} 吗？该班级的成员数据将先归档。`)) return;
    setDeletingClassId(item.id);
    setMessage(null);
    try {
      const result = await apiFetch<{ archiveDirectory: string }>(`/teacher/classes/${item.id}`, {
        method: "DELETE",
        token,
      });
      setSelectedId(null);
      await Promise.all([loadClasses(), refreshUser()]);
      setMessage(`班级已删除。归档目录：${result.archiveDirectory}`);
    } catch (error) {
      setMessage(error instanceof Error ? `删除班级失败：${error.message}` : "删除班级失败。");
    } finally {
      setDeletingClassId(null);
    }
  }

  async function updateClass(values: ClassEditValues) {
    if (!token || !editingClass) return;
    setSaving(true);
    setEditError(null);
    try {
      const data = await apiFetch<{ class: ClassItem }>(
        `/teacher/classes/${editingClass.id}`,
        {
          method: "PATCH",
          token,
          body: JSON.stringify(values),
        },
      );
      await loadClasses(data.class.id);
      if (data.class.isCurrent) await refreshUser();
      setMessage(`班级“${data.class.className || "未命名班级"}”已更新。`);
      setEditingClass(null);
    } catch (error) {
      setEditError(error instanceof Error ? error.message : "更新班级失败。");
    } finally {
      setSaving(false);
    }
  }

  const selected = classes.find((item) => item.id === selectedId);
  return (
    <main className={user?.role === "teacher" ? "classes-shell classes-shell-teacher" : "classes-shell"}>
      <header className="classes-header">
        <button className="icon-button" onClick={() => navigate("/portal")} title="返回服务门户" type="button">
          <Icon name="arrow" size={18} />
        </button>
        <div>
          <span>{user?.role === "teacher" ? "教师工具" : "班级管理"}</span>
          <h1>{user?.role === "teacher" ? "班级成员管理" : "班级与成员"}</h1>
        </div>
        {user?.role === "teacher" ? (
          <button className="primary-button classes-create-button" onClick={openCreateDialog} type="button">
            <Icon name="folderPlus" size={17} /> 新建班级
          </button>
        ) : null}
      </header>
      {message ? <div className="notice">{message}</div> : null}
      {!classesLoaded ? (
        <div className="classes-loading">正在加载班级...</div>
      ) : classes.length ? (
        <div className="classes-layout">
          <aside className="class-list">
            <div className="class-list-heading">
              <h2>我的班级</h2>
              <span>{classes.length}</span>
            </div>
            {classes.map((item) => (
              <button className={item.id === selectedId ? "class-item active" : "class-item"} key={item.id} onClick={() => setSelectedId(item.id)}>
                <strong>{item.className}</strong>
                <span>{item.courseName}</span>
                <code>{item.code}</code>
              </button>
            ))}
          </aside>
          {selected ? (
            <section className="class-members">
              <>
                <div className="class-members-title">
                <div>
                  <h2>{selected.className}</h2>
                  <p>{selected.courseName} · {selected.memberCount}/{selected.capacity} · <code>{selected.code}</code></p>
                </div>
                {user?.role === "teacher" ? (
                  <div className="class-title-actions">
                    <button className="ghost-button compact" onClick={() => { setEditError(null); setEditingClass(selected); }} type="button">
                      <Icon name="edit" size={15} /> 编辑班级
                    </button>
                    <button className="danger-button" disabled={deletingClassId !== null} onClick={() => void deleteClass(selected)} type="button">
                      {deletingClassId === selected.id ? "正在删除..." : "删除班级"}
                    </button>
                  </div>
                ) : null}
              </div>
              <div className="table-scroll">
                <table>
                  <thead><tr><th>成员</th><th>学号</th><th>角色</th><th>工作区</th><th>最近登录</th><th>操作</th></tr></thead>
                  <tbody>
                    {members.map((member) => (
                      <tr key={member.id}>
                        <td><strong>{member.name || "-"}</strong><small>{member.email}</small></td>
                        <td>{member.studentNo || "-"}</td>
                        <td>{member.role === "ta" ? "助教" : "学生"}</td>
                        <td>{member.workspaceStatus === "ready" ? "就绪" : member.workspaceStatus === "initializing" ? "初始化中" : member.workspaceStatus === "failed" ? "失败" : "未创建"}</td>
                        <td>{member.lastLoginAt ? new Date(member.lastLoginAt).toLocaleString() : "-"}</td>
                        <td className="row-actions">
                          {user?.role === "teacher" ? (
                            <button onClick={() => void changeRole(member)} type="button">
                              {member.role === "student" ? "设为助教" : "恢复为学生"}
                            </button>
                          ) : null}
                          <button className="danger-button" onClick={() => void deleteMember(member)} type="button">删除</button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                </div>
                {!members.length ? <p className="empty-state">暂无学生使用该班级邀请码注册。</p> : null}
              </>
            </section>
          ) : null}
        </div>
      ) : (
        <section className="classes-zero-state">
          <span><Icon name="users" size={28} /></span>
          <h2>{user?.role === "teacher" ? "尚未创建班级" : "尚未加入班级"}</h2>
          <p>{user?.role === "teacher" ? "创建班级后，系统会自动生成供学生注册使用的二级邀请码。" : "目前没有可供管理的班级。"}</p>
        </section>
      )}
      {createOpen ? (
        <div className="class-modal-backdrop" onMouseDown={() => { if (!creating) setCreateOpen(false); }}>
          <form
            aria-labelledby="create-class-title"
            aria-modal="true"
            className="class-create-dialog"
            onMouseDown={(event) => event.stopPropagation()}
            onSubmit={createClass}
            role="dialog"
          >
            <div className="class-dialog-header">
              <div><span>班级管理</span><h2 id="create-class-title">创建班级</h2></div>
              <button aria-label="关闭创建班级窗口" className="class-dialog-close" disabled={creating} onClick={() => setCreateOpen(false)} title="关闭" type="button">
                <Icon name="close" size={17} />
              </button>
            </div>
            <div className="class-create-form">
              <label>课程名称<input autoFocus name="courseName" required /></label>
              <label>班级名称<input name="className" required /></label>
              <label>人数上限<input defaultValue="50" min="1" max="10000" name="capacity" type="number" required /></label>
            </div>
            <p className="class-dialog-hint">创建后将自动生成一个以教师一级邀请码开头的班级邀请码。</p>
            {createError ? <div className="form-error">{createError}</div> : null}
            <div className="class-dialog-actions">
              <button className="ghost-button" disabled={creating} onClick={() => setCreateOpen(false)} type="button">取消</button>
              <button className="primary-button" disabled={creating} type="submit">{creating ? "正在创建..." : "创建班级"}</button>
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
