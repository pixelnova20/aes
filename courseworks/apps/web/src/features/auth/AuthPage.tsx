/**
 * 文件作用：实现前端“用户认证”功能模块的 React 界面与交互。
 * 模块位置：`apps/web/src/features/auth/AuthPage.tsx`，属于前端“用户认证”功能模块。
 * 重要函数：`AuthPage()` 负责处理`auth` 页面。
 */
import { FormEvent, useState } from "react";

import { apiFetch } from "../../shared/api/client";
import { useAuth } from "./auth-context";
import type { AuthUser } from "../../shared/types";

// 登录/注册接口返回的最小登录态载荷。
type AuthResponse = {
  token: string;
  user: AuthUser;
};

type AccountChoice = {
  id: string;
  name: string | null;
  role: AuthUser["role"];
  courseName: string | null;
  className: string | null;
};

type LoginResponse = AuthResponse | {
  requiresAccountSelection: true;
  accounts: AccountChoice[];
};

/**
 * 功能：处理`auth` 页面。
 * 输入：无显式输入参数。
 * 输出：返回 React 元素，供父组件渲染。
 * 调用关系：由 React 组件树或路由渲染过程调用；内部调用 `useAuth()`、`useState()`、`preventDefault()`、`setError()`、`setLoading()`、`fromEntries()`。
 */
export function AuthPage() {
  // 认证页同时承载登录和邀请码注册两种流程。
  const { setSession } = useAuth();
  const [mode, setMode] = useState<"login" | "register">(() =>
    new URLSearchParams(window.location.search).get("register") === "1" ? "register" : "login"
  );
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [pendingLogin, setPendingLogin] = useState<{
    email: string;
    password: string;
    accounts: AccountChoice[];
  } | null>(null);
  const [inviteInfo, setInviteInfo] = useState<{
    level: "level_1" | "level_2";
    role: "teacher" | "student";
    courseName: string | null;
    className: string | null;
  } | null>(null);

  /**
   * 功能：处理提交。
   * 输入：`event`（FormEvent<HTMLFormElement>）提供event。
   * 输出：返回该操作的完成状态；同步处理无结果时返回 void，异步处理返回 Promise。
   * 调用关系：由本模块其他函数、应用编排层、协议适配层或测试按需调用；内部调用 `preventDefault()`、`setError()`、`setLoading()`、`fromEntries()`、`entries()`、`apiFetch()`。
   */
  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    // 表单字段直接转成对象并交给后端校验，前端只做最小约束。
    event.preventDefault();
    setError(null);
    setLoading(true);

    const formData = new FormData(event.currentTarget);
    const payload = Object.fromEntries(formData.entries());

    try {
      if (mode === "register") {
        const code = String(payload.inviteCode || "").trim();
        const resolved = await apiFetch<NonNullable<typeof inviteInfo>>(`/auth/invites/${encodeURIComponent(code)}`);
        setInviteInfo(resolved);
        if (!String(payload.studentNo || "").trim()) {
          throw new Error(resolved.role === "teacher" ? "请输入教师工号。" : "请输入学生学号。");
        }
      }
      const data = await apiFetch<LoginResponse>(mode === "login" ? "/auth/login" : "/auth/register", {
        method: "POST",
        body: JSON.stringify(payload)
      });
      if ("requiresAccountSelection" in data) {
        setPendingLogin({
          email: String(payload.email),
          password: String(payload.password),
          accounts: data.accounts,
        });
        return;
      }
      setSession(data.token, data.user);
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : "请求失败。请稍后重试。");
    } finally {
      setLoading(false);
    }
  }

  async function selectAccount(accountId: string) {
    if (!pendingLogin) return;
    setError(null);
    setLoading(true);
    try {
      const data = await apiFetch<AuthResponse>("/auth/login", {
        method: "POST",
        body: JSON.stringify({
          email: pendingLogin.email,
          password: pendingLogin.password,
          accountId,
        }),
      });
      setPendingLogin(null);
      setSession(data.token, data.user);
    } catch (selectionError) {
      setError(selectionError instanceof Error ? selectionError.message : "登录失败。请稍后重试。");
    } finally {
      setLoading(false);
    }
  }

  function changeMode(nextMode: "login" | "register") {
    setMode(nextMode);
    setPendingLogin(null);
    setInviteInfo(null);
    setError(null);
  }

  async function inspectInvite(code: string) {
    setInviteInfo(null);
    if (!code.trim()) return;
    try {
      const data = await apiFetch<typeof inviteInfo>(`/auth/invites/${encodeURIComponent(code.trim())}`);
      setInviteInfo(data);
      setError(null);
    } catch (lookupError) {
      setError(lookupError instanceof Error ? lookupError.message : "邀请码无效。请检查后重试。");
    }
  }

  return (
    <div className="auth-shell">
      <div className="auth-card">
        <div className="auth-header">
          <h1>AES（AI-assisted Education System）</h1>
          <p>面向课程教学、实验和作业管理的一体化平台</p>
        </div>

        <div className="segmented">
          <button className={mode === "login" ? "active" : ""} onClick={() => changeMode("login")} type="button">
            登录
          </button>
          <button className={mode === "register" ? "active" : ""} onClick={() => changeMode("register")} type="button">
            注册
          </button>
        </div>

        {pendingLogin ? (
          <div className="form-stack">
            <h2>选择班级账号</h2>
            <div className="account-choice-list">
              {pendingLogin.accounts.map((account) => (
                <button
                  className="account-choice"
                  disabled={loading}
                  key={account.id}
                  onClick={() => void selectAccount(account.id)}
                  type="button"
                >
                  <strong>{account.courseName ?? account.name ?? "账号"}</strong>
                  <span>{account.className ?? (account.role === "teacher" ? "教师账号" : account.role === "ta" ? "助教账号" : "学生账号")}</span>
                </button>
              ))}
            </div>
            {error ? <div className="form-error">{error}</div> : null}
            <button className="ghost-button" disabled={loading} onClick={() => setPendingLogin(null)} type="button">
              返回
            </button>
          </div>
        ) : (
          <form className="form-stack" onSubmit={handleSubmit}>
          <label>
            邮箱
            <input name="email" type="email" required />
          </label>
          <label>
            密码
            <input name="password" type="password" minLength={6} required />
          </label>
          {mode === "register" ? (
            <>
              <label>
                确认密码
                <input name="confirmPassword" type="password" minLength={6} required />
              </label>
              <label>
                姓名
                <input name="name" type="text" required />
              </label>
              <label>
                邀请码
                <input name="inviteCode" onBlur={(event) => void inspectInvite(event.currentTarget.value)} type="text" required />
              </label>
              {inviteInfo ? (
                <div className="invite-preview">
                  <strong>{inviteInfo.role === "teacher" ? "教师账号" : "学生账号"}</strong>
                  <span>{inviteInfo.level === "level_1" ? "一级邀请码" : `${inviteInfo.courseName} / ${inviteInfo.className}`}</span>
                </div>
              ) : null}
              <label>
                {inviteInfo?.role === "teacher"
                  ? "教师工号"
                  : inviteInfo?.role === "student"
                    ? "学生学号"
                    : "工号 / 学号"}
                <input
                  name="studentNo"
                  onInput={(event) => event.currentTarget.setCustomValidity("")}
                  onInvalid={(event) => {
                    const label = inviteInfo?.role === "teacher"
                      ? "教师工号"
                      : inviteInfo?.role === "student"
                        ? "学生学号"
                        : "工号或学号";
                    event.currentTarget.setCustomValidity(
                      event.currentTarget.validity.valueMissing
                        ? `请输入${label}。`
                        : `${label}只能包含英文字母和数字。`,
                    );
                  }}
                  pattern="[A-Za-z0-9]+"
                  title="只能包含英文字母和数字"
                  type="text"
                  required
                />
              </label>
            </>
          ) : null}

          {error ? <div className="form-error">{error}</div> : null}
          <button className="primary-button" disabled={loading} type="submit">
            {loading ? "正在提交..." : mode === "login" ? "登录" : "注册"}
          </button>
          </form>
        )}
      </div>
    </div>
  );
}
