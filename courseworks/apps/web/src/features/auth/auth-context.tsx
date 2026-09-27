/**
 * 文件作用：实现前端“用户认证”功能模块中的 `AuthProvider`、`useAuth` 等能力。
 * 模块位置：`apps/web/src/features/auth/auth-context.tsx`，属于前端“用户认证”功能模块。
 * 重要函数：`AuthProvider()` 负责处理`auth` Provider；`useAuth()` 负责处理`use` `auth`。
 */
import { createContext, useContext, useEffect, useState } from "react";

import { apiFetch } from "../../shared/api/client";
import type { AuthUser } from "../../shared/types";

// 全站共享的登录态结构。
type AuthContextValue = {
  token: string | null;
  user: AuthUser | null;
  hydrated: boolean;
  setSession: (token: string, user: AuthUser) => void;
  logout: () => void;
  refreshUser: () => Promise<void>;
};

const AuthContext = createContext<AuthContextValue | null>(null);

const TOKEN_KEY = "courseworks-token";

/**
 * 功能：处理`auth` Provider。
 * 输入：`{ children }`（{ children: React.ReactNode }）提供{ children }。
 * 输出：返回 React 元素，供父组件渲染。
 * 调用关系：由 React 组件树或路由渲染过程调用；内部调用 `useState()`、`getItem()`、`useEffect()`、`setHydrated()`、`finally()`、`catch()`。
 */
export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [token, setToken] = useState<string | null>(() => localStorage.getItem(TOKEN_KEY));
  const [user, setUser] = useState<AuthUser | null>(null);
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    // 页面刷新后如果本地还有 token，就主动向后端恢复用户资料。
    if (!token) {
      setHydrated(true);
      return;
    }

    void apiFetch<{
      id: string;
      email: string;
      name?: string | null;
      studentNo?: string | null;
      role: AuthUser["role"];
      courseName: string | null;
      inviteCode: { className: string | null } | null;
      currentClass: { courseName: string | null; className: string | null } | null;
      workspace: { status: string } | null;
    }>("/auth/me", { token })
      .then((data) => {
        setUser({
          id: data.id,
          email: data.email,
          name: data.name,
          studentNo: data.studentNo,
          role: data.role,
          courseName: data.currentClass?.courseName ?? data.courseName,
          className: data.currentClass?.className ?? data.inviteCode?.className ?? null,
          workspaceStatus: data.workspace?.status ?? "not_created"
        });
      })
      .catch(() => {
        localStorage.removeItem(TOKEN_KEY);
        setToken(null);
        setUser(null);
      })
      .finally(() => setHydrated(true));
  }, [token]);

  /**
   * 功能：处理`set` 会话。
   * 输入：`nextToken`（string）提供next Token。 `nextUser`（AuthUser）提供next 用户。
   * 输出：返回该操作的完成状态；同步处理无结果时返回 void，异步处理返回 Promise。
   * 调用关系：由 `apps/web/src/features/auth/AuthPage.tsx:handleSubmit()`、`apps/web/src/features/lab/LabPage.tsx:loadSession()`、`apps/web/src/features/lab/LabPage.tsx:createShell()`、`apps/web/src/features/lab/LabPage.tsx:closeShell()`、`apps/web/src/features/lab/LabPage.tsx:selectShell()` 调用；内部调用 `setItem()`、`setToken()`、`setUser()`。
   */
  const setSession = (nextToken: string, nextUser: AuthUser) => {
    // 登录成功后把 token 落到 localStorage，保证刷新后可恢复。
    localStorage.setItem(TOKEN_KEY, nextToken);
    setToken(nextToken);
    setUser(nextUser);
  };

  /**
   * 功能：处理`logout`。
   * 输入：无显式输入参数。
   * 输出：返回该操作生成、查询或转换后的结果；异步实现以 Promise 交付结果。
   * 调用关系：由本模块其他函数、应用编排层、协议适配层或测试按需调用；内部调用 `removeItem()`、`setToken()`、`setUser()`。
   */
  const logout = () => {
    if (token) {
      void apiFetch("/auth/logout", { method: "POST", token, keepalive: true }).catch(() => undefined);
    }
    localStorage.removeItem(TOKEN_KEY);
    setToken(null);
    setUser(null);
  };

  /**
   * 功能：处理刷新 用户。
   * 输入：无显式输入参数。
   * 输出：返回该操作生成、查询或转换后的结果；异步实现以 Promise 交付结果。
   * 调用关系：由 `apps/web/src/features/workspace/WorkspacePage.tsx:initializeWorkspace()` 调用；内部调用 `apiFetch()`、`setUser()`。
   */
  const refreshUser = async () => {
    if (!token) {
      return;
    }
    const data = await apiFetch<{
      id: string;
      email: string;
      name?: string | null;
      studentNo?: string | null;
      role: AuthUser["role"];
      courseName: string | null;
      inviteCode: { className: string | null } | null;
      currentClass: { courseName: string | null; className: string | null } | null;
      workspace: { status: string } | null;
    }>("/auth/me", { token });
    setUser({
      id: data.id,
      email: data.email,
      name: data.name,
      studentNo: data.studentNo,
      role: data.role,
      courseName: data.currentClass?.courseName ?? data.courseName,
      className: data.currentClass?.className ?? data.inviteCode?.className ?? null,
      workspaceStatus: data.workspace?.status ?? "not_created"
    });
  };

  return (
    <AuthContext.Provider value={{ token, user, hydrated, setSession, logout, refreshUser }}>
      {children}
    </AuthContext.Provider>
  );
}

/**
 * 功能：处理`use` `auth`。
 * 输入：无显式输入参数。
 * 输出：返回该操作生成、查询或转换后的结果；异步实现以 Promise 交付结果。
 * 调用关系：由 `apps/web/src/app/App.tsx:HomeRedirect()`、`apps/web/src/features/admin/AdminPage.tsx:AdminPage()`、`apps/web/src/features/auth/AuthGate.tsx:AuthGate()`、`apps/web/src/features/auth/AuthPage.tsx:AuthPage()`、`apps/web/src/features/lab/LabPage.tsx:LabPage()` 调用；内部调用 `useContext()`。
 */
export function useAuth() {
  // 自定义 Hook，统一从 Context 读取认证状态。
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error("Auth context is not available.");
  }
  return context;
}
