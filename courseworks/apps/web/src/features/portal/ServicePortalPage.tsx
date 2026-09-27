import { FormEvent, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";

import { apiFetch } from "../../shared/api/client";
import { useAuth } from "../auth/auth-context";
import { Icon } from "../workspace/workspace-icons";
import { AiProviderProfilesPanel } from "./AiProviderProfilesPanel";

type ServiceAction = {
  title: string;
  description: string;
  icon: Parameters<typeof Icon>[0]["name"];
  run: () => void;
};

export function ServicePortalPage() {
  const navigate = useNavigate();
  const { token, user, logout, refreshUser } = useAuth();
  const [profileOpen, setProfileOpen] = useState(false);
  const [profileName, setProfileName] = useState("");
  const [profileStudentNo, setProfileStudentNo] = useState("");
  const [profileError, setProfileError] = useState<string | null>(null);
  const [profileMessage, setProfileMessage] = useState<string | null>(null);
  const [savingProfile, setSavingProfile] = useState(false);

  useEffect(() => {
    if (!profileOpen) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !savingProfile) setProfileOpen(false);
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [profileOpen, savingProfile]);

  function openProfile() {
    setProfileName(user?.name || "");
    setProfileStudentNo(user?.studentNo || "");
    setProfileError(null);
    setProfileOpen(true);
  }

  async function saveProfile(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!token) return;
    setSavingProfile(true);
    setProfileError(null);
    try {
      await apiFetch("/auth/me", {
        method: "PATCH",
        token,
        body: JSON.stringify({
          name: profileName,
          ...((user?.role === "student" || user?.role === "ta")
            ? { studentNo: profileStudentNo }
            : {}),
        }),
      });
      await refreshUser();
      setProfileOpen(false);
      setProfileMessage("账户资料已更新。");
    } catch (error) {
      setProfileError(error instanceof Error ? error.message : "更新账户资料失败。");
    } finally {
      setSavingProfile(false);
    }
  }

  async function openHomeworks() {
    if (!token) return;
    const tab = window.open("about:blank", "_blank");
    if (tab) tab.opener = null;
    try {
      const data = await apiFetch<{ url: string }>("/homeworks/sso-token", { token });
      if (tab) tab.location.href = data.url;
      else window.open(data.url, "_blank", "noopener,noreferrer");
    } catch (error) {
      if (tab) tab.close();
      window.alert(error instanceof Error ? error.message : "无法打开 Homeworks。请稍后重试。");
    }
  }

  async function openSlideshow() {
    if (!token) return;
    const tab = window.open("about:blank", "_blank");
    if (tab) tab.opener = null;
    try {
      const data = await apiFetch<{ url: string }>("/services/slideshow/sso-token", { token });
      if (tab) tab.location.href = data.url;
      else window.open(data.url, "_blank", "noopener,noreferrer");
    } catch (error) {
      if (tab) tab.close();
      window.alert(error instanceof Error ? error.message : "无法打开幻灯片。请稍后重试。");
    }
  }

  function openCourseworks() {
    window.open("/app", "_blank", "noopener,noreferrer");
  }

  const actions: ServiceAction[] = user?.role === "super_admin"
    ? [{
        title: "系统管理",
        description: "管理一级邀请码、用户账号、归档和系统运行情况。",
        icon: "settings",
        run: () => navigate("/admin"),
      }]
    : [
        {
          title: "Slideshow",
          description: user?.role === "teacher"
            ? "上传并浏览班级课程幻灯片。"
            : "阅读班级课件并使用 AI 辅助理解。",
          icon: "screen",
          run: () => void openSlideshow(),
        },
        {
          title: "Homeworks",
          description: user?.role === "student"
            ? "完成并提交班级作业。"
            : "创建、发布、审阅和批改作业。",
          icon: "homeworks",
          run: () => void openHomeworks(),
        },
        {
          title: "Courseworks",
          description: user?.role === "student"
            ? "进入课程工作区并完成实验。"
            : "进入实验工作区并查看班级进度。",
          icon: "spark",
          run: openCourseworks,
        },
        ...(user?.role === "ta" ? [{
          title: "班级管理",
          description: "查看班级名单并管理学生账号。",
          icon: "users" as const,
          run: () => navigate("/classes"),
        }] : []),
      ];

  return (
    <main className={`portal-shell portal-shell-${user?.role || "student"}`}>
      <header className="portal-header">
        <div className="portal-identity">
          <span className="portal-product">SLIDESHOW + HOMEWORKS + COURSEWORKS</span>
          <h1>服务门户</h1>
          <p>{user?.name || user?.email} <span>{user?.role === "super_admin" ? "超级管理员" : user?.role === "teacher" ? "教师" : user?.role === "ta" ? "助教" : "学生"}</span></p>
        </div>
        <div className="portal-header-side">
          {(user?.role === "teacher" || user?.role === "student" || user?.role === "ta") ? (
            <div className="portal-header-context">
              <span className="portal-current-context-icon"><Icon name="users" size={20} /></span>
              <div>
                <small>当前工作班级</small>
                <strong>{user.className || "未命名班级"}</strong>
                <span>{user.courseName || "未命名课程"}</span>
              </div>
            </div>
          ) : null}
          <div className="portal-header-actions">
            {(user?.role === "teacher" || user?.role === "student" || user?.role === "ta") ? (
              <div className="portal-context-actions">
                <button
                  className="ghost-button"
                  onClick={() => navigate(user.role === "teacher" ? "/teacher/classes/select" : "/student/classes")}
                  type="button"
                >
                  切换班级
                </button>
                {user.role === "teacher" ? (
                  <button className="ghost-button" onClick={() => navigate("/classes")} type="button">
                    班级成员管理
                  </button>
                ) : null}
              </div>
            ) : null}
            <div className="portal-account-actions">
              <button className="ghost-button portal-profile-button" onClick={openProfile} type="button">
                <Icon name="edit" size={16} /> 编辑资料
              </button>
              <button className="ghost-button portal-logout" onClick={logout} type="button">
                <Icon name="account" size={17} /> 退出登录
              </button>
            </div>
          </div>
        </div>
      </header>
      <div aria-hidden="true" className="portal-section-divider" />
      {profileMessage ? <div className="notice portal-profile-notice">{profileMessage}</div> : null}
      {user && user.role !== "super_admin" && token ? (
        <AiProviderProfilesPanel token={token} role={user.role} />
      ) : null}
      {user?.role !== "super_admin" ? <div aria-hidden="true" className="portal-section-divider" /> : null}
      <section className="portal-service-section" aria-labelledby="portal-services-title">
        <div className="portal-section-heading">
          <span>教学工作台</span>
          <h2 id="portal-services-title">教学服务</h2>
        </div>
        <div className={user?.role === "super_admin" ? "portal-services portal-services-admin" : "portal-services"}>
          {actions.map((action) => (
            <button className={`portal-service portal-service-${action.title.toLowerCase()}`} key={action.title} onClick={action.run} type="button">
              <span className="portal-service-icon"><Icon name={action.icon} size={24} /></span>
              <span>
                <strong>{action.title}</strong>
                <small>{action.description}</small>
              </span>
              <Icon name="arrow" size={18} />
            </button>
          ))}
        </div>
      </section>
      {profileOpen ? (
        <div className="class-modal-backdrop" onMouseDown={() => { if (!savingProfile) setProfileOpen(false); }}>
          <form aria-labelledby="profile-title" aria-modal="true" className="class-create-dialog" onMouseDown={(event) => event.stopPropagation()} onSubmit={saveProfile} role="dialog">
            <div className="class-dialog-header">
              <div><span>账户设置</span><h2 id="profile-title">编辑个人资料</h2></div>
              <button aria-label="关闭账户资料窗口" className="class-dialog-close" disabled={savingProfile} onClick={() => setProfileOpen(false)} title="关闭" type="button">
                <Icon name="close" size={17} />
              </button>
            </div>
            <div className="class-dialog-context">
              <small>登录邮箱</small>
              <strong>{user?.email}</strong>
            </div>
            <div className="class-create-form">
              <label>姓名<input autoFocus maxLength={255} onChange={(event) => setProfileName(event.target.value)} required value={profileName} /></label>
              {user?.role === "student" || user?.role === "ta" ? (
                <label>
                  学号
                  <input
                    autoComplete="off"
                    maxLength={64}
                    onChange={(event) => setProfileStudentNo(event.target.value)}
                    pattern="[A-Za-z0-9]+"
                    required
                    value={profileStudentNo}
                  />
                </label>
              ) : null}
            </div>
            {profileError ? <div className="form-error">{profileError}</div> : null}
            <div className="class-dialog-actions">
              <button className="ghost-button" disabled={savingProfile} onClick={() => setProfileOpen(false)} type="button">取消</button>
              <button className="primary-button" disabled={savingProfile} type="submit">{savingProfile ? "保存中..." : "保存"}</button>
            </div>
          </form>
        </div>
      ) : null}
    </main>
  );
}
