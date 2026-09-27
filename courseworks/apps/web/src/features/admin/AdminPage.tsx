/**
 * 文件作用：实现前端“平台管理”功能模块的 React 界面与交互。
 * 模块位置：`apps/web/src/features/admin/AdminPage.tsx`，属于前端“平台管理”功能模块。
 * 重要函数：`AdminPage()` 负责处理`admin` 页面。
 */
import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";

import { apiFetch } from "../../shared/api/client";
import { useAuth } from "../auth/auth-context";
import { Icon, type IconName } from "../workspace/workspace-icons";

// 管理后台的页签视图。
type AdminTab = "overview" | "users" | "inviteCodes" | "workspaces" | "agentRuns";
type ManagedRole = "teacher" | "ta" | "student";

const ADMIN_TABS: Array<{
  id: AdminTab;
  label: string;
  description: string;
  icon: IconName;
}> = [
  { id: "overview", label: "概览", description: "查看平台核心数据与运行入口", icon: "panel" },
  { id: "users", label: "用户", description: "管理账户、角色和用户状态", icon: "users" },
  { id: "inviteCodes", label: "邀请码", description: "创建和维护两级邀请码", icon: "key" },
  { id: "workspaces", label: "工作区", description: "查看课程工作区及运行环境", icon: "folder" },
  { id: "agentRuns", label: "Agent 运行", description: "检查 Agent 执行轨迹与结果", icon: "spark" },
];

const ROLE_LABELS: Record<string, string> = {
  super_admin: "超级管理员",
  teacher: "教师",
  ta: "助教",
  student: "学生",
};

const STATUS_LABELS: Record<string, string> = {
  active: "启用",
  disabled: "停用",
  not_created: "未创建",
  initializing: "初始化中",
  ready: "就绪",
  failed: "失败",
  pending: "等待中",
  running: "运行中",
  completed: "已完成",
  success: "成功",
  passed: "通过",
  cancelled: "已取消",
};

function statusLabel(value: string | null | undefined) {
  if (!value) return "-";
  return STATUS_LABELS[value] ?? value;
}

/**
 * 功能：处理`admin` 页面。
 * 输入：无显式输入参数。
 * 输出：返回 React 元素，供父组件渲染。
 * 调用关系：由 React 组件树或路由渲染过程调用；内部调用 `useAuth()`、`useState()`、`all()`、`apiFetch()`、`setSummary()`、`setUsers()`。
 */
export function AdminPage() {
  // AdminPage 负责汇总平台运营视角的数据：
  // 用户、邀请码、workspace、Agent Run，以及 super_admin 的管理员管理。
  const { token, user, logout } = useAuth();
  const navigate = useNavigate();
  const [tab, setTab] = useState<AdminTab>("overview");
  const [summary, setSummary] = useState<{ users: number; inviteCodes: number; workspaces: number } | null>(null);
  const [users, setUsers] = useState<any[]>([]);
  const [inviteCodes, setInviteCodes] = useState<any[]>([]);
  const [workspaces, setWorkspaces] = useState<any[]>([]);
  const [agentRuns, setAgentRuns] = useState<any[]>([]);
  const [selectedAgentRun, setSelectedAgentRun] = useState<any | null>(null);
  const [pendingRoles, setPendingRoles] = useState<Record<string, ManagedRole>>({});
  const [message, setMessage] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  /**
   * 功能：加载`all`。
   * 输入：无显式输入参数。
   * 输出：返回该操作生成、查询或转换后的结果；异步实现以 Promise 交付结果。
   * 调用关系：由 `apps/web/src/features/admin/AdminPage.tsx:AdminPage()`、`apps/web/src/features/admin/AdminPage.tsx:createInviteCode()`、`apps/web/src/features/admin/AdminPage.tsx:updateUserRole()`、`apps/web/src/features/admin/AdminPage.tsx:toggleInviteCode()`、`apps/web/src/features/admin/AdminPage.tsx:deleteInviteCode()` 调用；内部调用 `all()`、`apiFetch()`、`setSummary()`、`setUsers()`、`setInviteCodes()`、`setWorkspaces()`。
   */
  async function loadAll() {
    // 后台首页需要的主数据统一从这里并行拉取。
    if (!token) {
      return;
    }

    setLoading(true);
    setLoadError(null);
    const requests = [
      { label: "概览", request: apiFetch<{ users: number; inviteCodes: number; workspaces: number }>("/admin/summary", { token }).then(setSummary) },
      { label: "用户", request: apiFetch<{ users: any[] }>("/admin/users", { token }).then((data) => setUsers(data.users)) },
      { label: "邀请码", request: apiFetch<{ inviteCodes: any[] }>("/admin/invite-codes", { token }).then((data) => setInviteCodes(data.inviteCodes)) },
      { label: "工作区", request: apiFetch<{ workspaces: any[] }>("/admin/workspaces", { token }).then((data) => setWorkspaces(data.workspaces)) },
      { label: "Agent 运行", request: apiFetch<{ runs: any[] }>("/admin/agent-runs", { token }).then((data) => setAgentRuns(data.runs)) }
    ];
    const results = await Promise.allSettled(requests.map((item) => item.request));
    const failed = results.flatMap((result, index) => result.status === "rejected" ? [requests[index].label] : []);
    if (failed.length) {
      setLoadError(`${failed.join("、")}数据加载失败，其他已成功的数据仍可使用。`);
    }
    setLoading(false);
  }

  useEffect(() => {
    void loadAll();
  }, [token]);

  useEffect(() => {
    if (message) {
      setMessage(null);
    }
  }, [tab]);

  const activeTab = ADMIN_TABS.find((item) => item.id === tab) ?? ADMIN_TABS[0]!;

  /**
   * 功能：创建邀请码 代码。
   * 输入：`event`（React.FormEvent<HTMLFormElement>）提供event。
   * 输出：返回该操作生成、查询或转换后的结果；异步实现以 Promise 交付结果。
   * 调用关系：由 `apps/server/src/transport/http/routes/admin.router.ts 顶层流程` 调用；内部调用 `preventDefault()`、`apiFetch()`、`stringify()`、`setMessage()`、`reset()`、`loadAll()`。
   */
  async function createInviteCode(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    if (!token) {
      return;
    }
    const formData = new FormData(event.currentTarget);
    const payload = {
      code: String(formData.get("code") || ""),
      description: String(formData.get("description") || "")
    };
    await apiFetch("/admin/invite-codes", {
      method: "POST",
      token,
      body: JSON.stringify(payload)
    });
    setMessage("一级邀请码已创建。");
    form.reset();
    await loadAll();
  }

  /**
   * 功能：更新用户 角色。
   * 输入：`userId`（string）提供用户 id。 `role`（"teacher" | "student"）提供角色。
   * 输出：返回该操作的完成状态；同步处理无结果时返回 void，异步处理返回 Promise。
   * 调用关系：由 `apps/web/src/features/admin/AdminPage.tsx:AdminPage()` 调用；内部调用 `apiFetch()`、`stringify()`、`loadAll()`。
   */
  async function applyUserRole(userId: string) {
    if (!token) {
      return;
    }
    const role = pendingRoles[userId];
    if (!role) return;
    await apiFetch(`/admin/users/${userId}/role`, {
      method: "PATCH",
      token,
      body: JSON.stringify({ role })
    });
    setPendingRoles((current) => {
      const next = { ...current };
      delete next[userId];
      return next;
    });
    setMessage("用户角色已更新。");
    await loadAll();
  }

  function cancelUserRole(userId: string) {
    setPendingRoles((current) => {
      const next = { ...current };
      delete next[userId];
      return next;
    });
  }

  async function deleteUser(entry: { id: string; email: string }) {
    if (!token) return;
    const confirmed = window.confirm(
      `确认删除用户 ${entry.email} 吗？该账号在 AES、Homeworks 和 Slideshow 中的数据将先归档。`,
    );
    if (!confirmed) return;
    try {
      const result = await apiFetch<{ archiveDirectory: string }>(`/admin/users/${entry.id}`, {
        method: "DELETE",
        token,
      });
      setMessage(`用户已删除。归档目录：${result.archiveDirectory}`);
      await loadAll();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "删除用户失败。");
    }
  }

  /**
   * 功能：切换邀请码 代码。
   * 输入：`inviteCodeId`（string）提供邀请码 代码 id。 `isActive`（boolean）提供is active。
   * 输出：返回该操作的完成状态；同步处理无结果时返回 void，异步处理返回 Promise。
   * 调用关系：由 `apps/web/src/features/admin/AdminPage.tsx:AdminPage()` 调用；内部调用 `apiFetch()`、`stringify()`、`loadAll()`。
   */
  async function toggleInviteCode(inviteCodeId: string, isActive: boolean) {
    if (!token) {
      return;
    }
    await apiFetch(`/admin/invite-codes/${inviteCodeId}/status`, {
      method: "PATCH",
      token,
      body: JSON.stringify({ isActive })
    });
    await loadAll();
  }

  /**
   * 功能：删除邀请码 代码。
   * 输入：`inviteCodeId`（string）提供邀请码 代码 id。
   * 输出：返回该操作的完成状态；同步处理无结果时返回 void，异步处理返回 Promise。
   * 调用关系：由 `apps/server/src/transport/http/routes/admin.router.ts 顶层流程`、`apps/web/src/features/admin/AdminPage.tsx:AdminPage()` 调用；内部调用 `confirm()`、`apiFetch()`、`setMessage()`、`loadAll()`。
   */
  async function deleteInviteCode(inviteCode: { id: string; code: string; relatedUserCount: number }) {
    if (!token) {
      return;
    }

    const confirmed = window.confirm(
      `确认删除邀请码 ${inviteCode.code} 及其关联的 ${inviteCode.relatedUserCount} 个账号吗？`
      + "相关教师、助教和学生数据将先归档。",
    );
    if (!confirmed) {
      return;
    }

    try {
      const result = await apiFetch<{ archiveDirectory: string }>(`/admin/invite-codes/${inviteCode.id}`, {
        method: "DELETE",
        token
      });
      setMessage(`邀请码及 ${inviteCode.relatedUserCount} 个关联账号已删除。归档目录：${result.archiveDirectory}`);
      await loadAll();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "删除邀请码失败。");
    }
  }

  /**
   * 功能：打开Agent 运行。
   * 输入：`agentRunId`（string）提供Agent 运行 id。
   * 输出：返回该操作生成、查询或转换后的结果；异步实现以 Promise 交付结果。
   * 调用关系：由 `apps/web/src/features/admin/AdminPage.tsx:AdminPage()` 调用；内部调用 `apiFetch()`、`setSelectedAgentRun()`。
   */
  async function openAgentRun(agentRunId: string) {
    // 管理员查看某一次 Agent Run 详情时，按需单独加载。
    if (!token) return;
    const data = await apiFetch<{ run: any }>(`/admin/agent-runs/${agentRunId}`, { token });
    setSelectedAgentRun(data.run);
  }

  return (
    <div className="dashboard-shell admin-shell">
      <aside className="sidebar admin-sidebar">
        <div className="admin-sidebar-brand">
          <span className="admin-brand-mark"><Icon name="settings" size={22} /></span>
          <div>
            <small>AES PLATFORM</small>
            <h2>管理控制台</h2>
          </div>
        </div>
        <div className="admin-identity">
          <span className="admin-avatar"><Icon name="account" size={20} /></span>
          <div>
            <strong>超级管理员</strong>
            <small>{user?.email}</small>
          </div>
        </div>
        <nav className="nav-list admin-nav" aria-label="管理功能">
          {ADMIN_TABS.map((item) => (
            <button key={item.id} className={tab === item.id ? "active" : ""} onClick={() => setTab(item.id)} type="button">
              <Icon name={item.icon} size={18} />
              <span>{item.label}</span>
              {item.id === "users" && summary ? <small>{summary.users}</small> : null}
              {item.id === "inviteCodes" && summary ? <small>{summary.inviteCodes}</small> : null}
              {item.id === "workspaces" && summary ? <small>{summary.workspaces}</small> : null}
            </button>
          ))}
        </nav>
        <div className="admin-sidebar-footer">
          <button onClick={() => navigate("/portal")} type="button"><Icon name="arrow" size={17} />服务门户</button>
          <button onClick={logout} type="button"><Icon name="account" size={17} />退出登录</button>
        </div>
      </aside>

      <main className="content-panel admin-content">
        <header className="admin-page-header">
          <div>
            <span>平台管理</span>
            <h1>{activeTab.label}</h1>
            <p>{activeTab.description}</p>
          </div>
          <button className="admin-refresh-button" disabled={loading} onClick={() => void loadAll()} title="刷新管理数据" type="button">
            <Icon name="refresh" size={18} />
            {loading ? "正在刷新" : "刷新数据"}
          </button>
        </header>
        {message ? <div className="notice">{message}</div> : null}
        {loading ? <div className="notice">正在加载管理数据，已返回的内容会立即显示...</div> : null}
        {loadError ? (
          <div className="form-error">
            {loadError}
            <button className="ghost-button" onClick={() => void loadAll()} type="button">重新加载</button>
          </div>
        ) : null}

        {tab === "overview" && summary ? (
          <section className="admin-overview">
            <div className="card-grid admin-metric-grid">
            <article className="metric-card admin-metric-card">
              <span className="admin-metric-icon users"><Icon name="users" size={22} /></span>
              <div><small>平台账户</small><strong>{summary.users}</strong><span>用户</span></div>
              <button onClick={() => setTab("users")} title="查看用户" type="button"><Icon name="chevronRight" /></button>
            </article>
            <article className="metric-card admin-metric-card">
              <span className="admin-metric-icon invites"><Icon name="key" size={22} /></span>
              <div><small>注册入口</small><strong>{summary.inviteCodes}</strong><span>邀请码</span></div>
              <button onClick={() => setTab("inviteCodes")} title="查看邀请码" type="button"><Icon name="chevronRight" /></button>
            </article>
            <article className="metric-card admin-metric-card">
              <span className="admin-metric-icon workspaces"><Icon name="folder" size={22} /></span>
              <div><small>实验环境</small><strong>{summary.workspaces}</strong><span>工作区</span></div>
              <button onClick={() => setTab("workspaces")} title="查看工作区" type="button"><Icon name="chevronRight" /></button>
            </article>
            </div>
            <div className="admin-overview-band">
              <div><span>管理建议</span><strong>从用户和邀请码开始维护教学组织</strong><p>用户数据删除前会归档；角色变更只有点击“应用”后才会生效。</p></div>
              <button onClick={() => setTab("inviteCodes")} type="button"><Icon name="key" size={18} />管理邀请码</button>
            </div>
          </section>
        ) : null}

        {tab === "users" ? (
          <section className="table-card admin-table-card">
            <div className="admin-section-heading"><div><h3>用户管理</h3><p>调整用户角色或归档并删除账户</p></div><span>{users.length} 个账户</span></div>
            <div className="table-scroll admin-users-scroll">
            <table className="admin-users-table">
              <thead>
                <tr>
                  <th>邮箱</th>
                  <th>姓名</th>
                  <th>角色</th>
                  <th>工号 / 学号</th>
                  <th>课程</th>
                  <th>状态</th>
                  <th>班级</th>
                  <th>工作区</th>
                  <th>AI</th>
                  <th>目标架构</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                {users.map((entry) => (
                  <tr key={entry.id}>
                    <td>{entry.email}</td>
                    <td>{entry.name ?? "-"}</td>
                    <td>{ROLE_LABELS[entry.role] ?? entry.role}</td>
                    <td>{entry.studentNo ?? "-"}</td>
                    <td>{entry.courseName ?? "-"}</td>
                    <td>{entry.isActive ? "启用" : "停用"}</td>
                    <td>{entry.className ?? "-"}</td>
                    <td>{statusLabel(entry.workspaceStatus)}</td>
                    <td>{entry.aiProviderConfigured ? "已配置" : "未配置"}</td>
                    <td>{entry.targetArch ?? "-"}</td>
                    <td>
                      {entry.role === "super_admin" ? "-" : (
                        <div className="role-editor">
                          <select
                            aria-label={`${entry.email} 的角色`}
                            value={pendingRoles[entry.id] ?? entry.role}
                            onChange={(event) => setPendingRoles((current) => ({
                              ...current,
                              [entry.id]: event.target.value as ManagedRole
                            }))}
                          >
                            <option value="teacher">教师</option>
                            <option value="ta">助教</option>
                            <option value="student">学生</option>
                          </select>
                          <div className="row-actions">
                            <button
                              disabled={!pendingRoles[entry.id] || pendingRoles[entry.id] === entry.role}
                              onClick={() => cancelUserRole(entry.id)}
                              type="button"
                            >
                              取消
                            </button>
                            <button
                              className="primary-button compact"
                              disabled={!pendingRoles[entry.id] || pendingRoles[entry.id] === entry.role}
                              onClick={() => void applyUserRole(entry.id)}
                              type="button"
                            >
                              应用
                            </button>
                          </div>
                          <button
                            className="danger-button compact"
                            onClick={() => void deleteUser(entry)}
                            type="button"
                          >
                            删除用户
                          </button>
                        </div>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            </div>
          </section>
        ) : null}

        {tab === "inviteCodes" ? (
          <section className="split-panel admin-invite-layout">
            <form className="form-card admin-create-card" onSubmit={createInviteCode}>
              <span className="admin-form-icon"><Icon name="key" size={20} /></span>
              <div><h3>创建一级邀请码</h3><p>一级邀请码用于教师注册，创建后长期有效且仅可使用一次。</p></div>
              <label>邀请码<input name="code" required /></label>
              <label>描述<input name="description" /></label>
              <button className="primary-button" type="submit"><Icon name="plus" size={17} />创建邀请码</button>
            </form>
            <div className="table-card admin-table-card">
              <div className="admin-section-heading"><div><h3>邀请码列表</h3><p>一级教师邀请码及其派生的二级班级邀请码</p></div><span>{inviteCodes.length} 条记录</span></div>
              <div className="table-scroll">
                <table>
                <thead>
                  <tr>
                    <th>邀请码</th>
                    <th>描述</th>
                    <th>级别</th>
                    <th>上级邀请码</th>
                    <th>课程</th>
                    <th>班级</th>
                    <th>教师</th>
                    <th>使用情况</th>
                    <th>操作</th>
                  </tr>
                </thead>
                <tbody>
                  {inviteCodes.map((item) => (
                    <tr key={item.id}>
                      <td>{item.code}</td>
                      <td>{item.description?.trim() || "-"}</td>
                      <td>{item.level === "level_1" ? "一级" : "二级"}</td>
                      <td>{item.parentCode ?? "-"}</td>
                      <td>{item.courseName ?? "-"}</td>
                      <td>{item.className ?? "-"}</td>
                      <td>{item.teacher ?? "-"}</td>
                      <td>{item.usedCount} / {item.maxUses}</td>
                      <td className="row-actions">
                        <button onClick={() => toggleInviteCode(item.id, !item.isActive)}>
                          {item.isActive ? "停用" : "启用"}
                        </button>
                        <button className="danger-button" onClick={() => void deleteInviteCode(item)}>
                          删除
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
                </table>
              </div>
            </div>
          </section>
        ) : null}

        {tab === "workspaces" ? (
          <section className="table-card admin-table-card">
            <div className="admin-section-heading"><div><h3>工作区</h3><p>查看用户实验环境、目标平台及存储位置</p></div><span>{workspaces.length} 个工作区</span></div>
            <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>用户</th>
                  <th>角色</th>
                  <th>状态</th>
                  <th>系统类型</th>
                  <th>目标平台</th>
                  <th>路径</th>
                </tr>
              </thead>
              <tbody>
                {workspaces.map((item) => (
                  <tr key={item.id}>
                    <td>{item.email}</td>
                    <td>{ROLE_LABELS[item.role] ?? item.role}</td>
                    <td>{statusLabel(item.workspaceStatus)}</td>
                    <td>{item.osType}</td>
                    <td>{item.targetArch} / {item.targetPlatform}</td>
                    <td>{item.path}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            </div>
          </section>
        ) : null}



        {tab === "agentRuns" ? (
          <section className="split-panel agent-monitor">
            <div className="table-card admin-table-card">
              <div className="admin-section-heading"><div><h3>Agent 运行记录</h3><p>点击记录查看执行详情</p></div><span>{agentRuns.length} 次运行</span></div>
              <div className="table-scroll">
              <table>
                <thead>
                  <tr>
                    <th>用户</th><th>角色</th><th>班级</th><th>状态</th><th>步骤</th><th>补丁</th><th>构建</th><th>QEMU</th><th>更新时间</th>
                  </tr>
                </thead>
                <tbody>
                  {agentRuns.map((run) => (
                    <tr key={run.id} onClick={() => void openAgentRun(run.id)} className="clickable-row">
                      <td>{run.email}</td><td>{ROLE_LABELS[run.role] ?? run.role}</td><td>{run.className ?? "-"}</td><td>{statusLabel(run.status)}</td><td>{run.currentStep ?? "-"}</td><td>{statusLabel(run.patchPlanStatus)}</td><td>{statusLabel(run.lastBuildStatus)}</td><td>{statusLabel(run.lastQemuSmokeStatus)}</td><td>{new Date(run.updatedAt).toLocaleString("zh-CN")}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              </div>
            </div>
            <div className="table-card agent-detail admin-agent-detail">
              <div className="admin-section-heading"><div><h3>运行详情</h3><p>执行轨迹、补丁、构建和 QEMU 输出</p></div></div>
              {selectedAgentRun ? (
                <div>
                  <p><strong>{selectedAgentRun.user.email}</strong> · {selectedAgentRun.status} · {selectedAgentRun.currentStep}</p>
                  <pre className="agent-run-detail-output">{[
                    `用户指令：${selectedAgentRun.prompt}`,
                    "",
                    "执行轨迹：",
                    ...(selectedAgentRun.traceEvents ?? []).map((event: any) => `[${event.stepStatus}] ${event.stepName}\n${event.outputSummaryMarkdown ?? event.inputSummaryMarkdown ?? event.errorMarkdown ?? ""}`),
                    "",
                    "设计：",
                    selectedAgentRun.patchPlans?.[0]?.designMarkdown ?? "-",
                    "",
                    "补丁：",
                    selectedAgentRun.patchPlans?.[0]?.patch ?? "-",
                    "",
                    "构建：",
                    selectedAgentRun.buildRuns?.[0]?.logSummaryMarkdown ?? selectedAgentRun.buildRuns?.[0]?.log ?? "-",
                    "",
                    "QEMU:",
                    selectedAgentRun.qemuSmokeRuns?.[0]?.outputSummaryMarkdown ?? selectedAgentRun.qemuSmokeRuns?.[0]?.output ?? "-"
                  ].join("\n")}</pre>
                </div>
              ) : <p>请选择一条 Agent 运行记录，以查看摘要、补丁、构建日志和 QEMU 输出。</p>}
            </div>
          </section>
        ) : null}
      </main>
    </div>
  );
}
