import { FormEvent, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";

import { apiFetch } from "../../shared/api/client";
import { useAuth } from "../auth/auth-context";
import { Icon } from "../workspace/workspace-icons";

type StudentClass = {
  accountId: string;
  courseName: string | null;
  className: string | null;
  inviteCode: string;
  role: "student" | "ta";
  teacher?: { email: string; name: string | null } | null;
  isCurrent: boolean;
  isActive: boolean;
};

export function StudentClassesPage() {
  const navigate = useNavigate();
  const { token, logout, setSession } = useAuth();
  const [classes, setClasses] = useState<StudentClass[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [joining, setJoining] = useState(false);
  const [switchingId, setSwitchingId] = useState<string | null>(null);
  const [leavingId, setLeavingId] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function loadClasses() {
    if (!token) return;
    try {
      const data = await apiFetch<{ classes: StudentClass[] }>("/student/classes", { token });
      setClasses(data.classes);
      setError(null);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "无法加载班级列表。");
    } finally {
      setLoaded(true);
    }
  }

  useEffect(() => { void loadClasses(); }, [token]);

  async function joinClass(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!token) return;
    const form = event.currentTarget;
    const inviteCode = String(new FormData(form).get("inviteCode") || "").trim();
    setJoining(true);
    setMessage(null);
    setError(null);
    try {
      const data = await apiFetch<{ class: StudentClass }>("/student/classes", {
        method: "POST",
        token,
        body: JSON.stringify({ inviteCode }),
      });
      form.reset();
      setMessage(`已加入 ${data.class.courseName || "课程"} / ${data.class.className || "班级"}。`);
      await loadClasses();
    } catch (joinError) {
      setError(joinError instanceof Error ? joinError.message : "加入班级失败。");
    } finally {
      setJoining(false);
    }
  }

  async function leaveClass(item: StudentClass) {
    if (!token || leavingId || switchingId) return;
    const currentWarning = item.isCurrent ? "这是你当前使用的班级，离开后会立即退出登录。" : "";
    if (!window.confirm(`确认离开 ${item.courseName || "课程"} / ${item.className || "班级"}？${currentWarning}相关作品会先归档。`)) return;
    setLeavingId(item.accountId);
    setMessage(null);
    setError(null);
    try {
      const result = await apiFetch<{ currentAccountDeleted: boolean }>(`/student/classes/${item.accountId}`, {
        method: "DELETE",
        token,
      });
      if (result.currentAccountDeleted) {
        logout();
        navigate("/", { replace: true });
        return;
      }
      setMessage(`已离开 ${item.className || "班级"}，该班级中的作品已归档。`);
      await loadClasses();
    } catch (leaveError) {
      setError(leaveError instanceof Error ? leaveError.message : "离开班级失败。");
    } finally {
      setLeavingId(null);
    }
  }

  async function selectClass(item: StudentClass) {
    if (!token || item.isCurrent || switchingId || leavingId) return;
    setSwitchingId(item.accountId);
    setMessage(null);
    setError(null);
    try {
      const session = await apiFetch<{
        token: string;
        user: Parameters<typeof setSession>[1];
      }>(`/student/classes/${item.accountId}/select`, {
        method: "POST",
        token,
      });
      setSession(session.token, session.user);
      setClasses((current) => current.map((entry) => ({
        ...entry,
        isCurrent: entry.accountId === item.accountId,
      })));

      try {
        const homeworks = await apiFetch<{ url: string }>("/homeworks/sso-token", {
          token: session.token,
        });
        await fetch(homeworks.url, { credentials: "same-origin" });
        setMessage(`已切换到 ${item.courseName || "课程"} / ${item.className || "班级"}。`);
      } catch {
        setMessage(`已切换到 ${item.courseName || "课程"} / ${item.className || "班级"}；下次进入作业系统时会同步班级。`);
      }
    } catch (switchError) {
      setError(switchError instanceof Error ? switchError.message : "切换班级失败。");
    } finally {
      setSwitchingId(null);
    }
  }

  return (
    <main className="classes-shell student-classes-shell">
      <header className="classes-header">
        <button className="icon-button" onClick={() => navigate("/portal")} title="返回服务门户" type="button">
          <Icon name="arrow" size={18} />
        </button>
        <div><span>学生班级</span><h1>我的班级</h1></div>
      </header>

      {message ? <div className="notice success">{message}</div> : null}
      {error ? <div className="form-error student-classes-message">{error}</div> : null}

      <div className="student-classes-layout">
        <section className="student-join-panel">
          <div className="student-panel-heading">
            <span><Icon name="folderPlus" size={20} /></span>
            <div><h2>加入新班级</h2><p>输入教师提供的班级邀请码</p></div>
          </div>
          <form onSubmit={joinClass}>
            <label htmlFor="student-invite-code">班级邀请码</label>
            <input id="student-invite-code" name="inviteCode" placeholder="例如 TEACHER-001" required />
            <button className="primary-button" disabled={joining} type="submit">
              {joining ? "正在加入..." : "确认加入"}
            </button>
          </form>
        </section>

        <section className="student-class-list-panel">
          <div className="student-class-list-heading">
            <h2>所属班级</h2>
            <span>{classes.length}</span>
          </div>
          {!loaded ? <p className="empty-state">正在加载班级...</p> : null}
          {loaded && !classes.length ? <p className="empty-state">当前没有所属班级。</p> : null}
          {classes.map((item) => (
            <article className="student-class-row" key={item.accountId}>
              <div className="student-class-main">
                <div className="student-class-title">
                  <strong>{item.className || "未命名班级"}</strong>
                  {item.isCurrent ? <span>当前班级</span> : null}
                  {item.role === "ta" ? <span className="ta">助教</span> : null}
                </div>
                <p>{item.courseName || "未命名课程"}</p>
                <small>{item.teacher?.name || item.teacher?.email || "教师未设置"} · <code>{item.inviteCode}</code></small>
              </div>
              <div className="student-class-actions">
                {!item.isCurrent ? (
                  <button
                    className="ghost-button compact"
                    disabled={leavingId !== null || switchingId !== null}
                    onClick={() => void selectClass(item)}
                    type="button"
                  >
                    {switchingId === item.accountId ? "正在切换..." : "切换到此班级"}
                  </button>
                ) : null}
                <button
                  className="danger-button compact"
                  disabled={leavingId !== null || switchingId !== null}
                  onClick={() => void leaveClass(item)}
                  type="button"
                >
                  {leavingId === item.accountId ? "正在离开..." : "离开班级"}
                </button>
              </div>
            </article>
          ))}
        </section>
      </div>
    </main>
  );
}
