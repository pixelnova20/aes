/**
 * 文件作用：实现前端“用户认证”功能模块的 React 界面与交互。
 * 模块位置：`apps/web/src/features/auth/AuthGate.tsx`，属于前端“用户认证”功能模块。
 * 重要函数：`AuthGate()` 负责处理`auth` `gate`。
 */
import { Navigate } from "react-router-dom";

import { useAuth } from "./auth-context";
import type { UserRole } from "../../shared/types";

// 受保护页面统一通过 AuthGate 控制：
// 未登录跳回首页，角色不符则跳到该用户自己的默认页。
/**
 * 功能：处理`auth` `gate`。
 * 输入：`{ roles, children }`（{ roles?: UserRole[]; children: React.ReactNode; }）提供{ roles, children }。
 * 输出：返回 React 元素，供父组件渲染。
 * 调用关系：由 React 组件树或路由渲染过程调用；内部调用 `useAuth()`、`includes()`。
 */
export function AuthGate({
  roles,
  children
}: {
  roles?: UserRole[];
  children: React.ReactNode;
}) {
  const { hydrated, user } = useAuth();

  if (!hydrated) {
    return <div className="screen-center">正在加载...</div>;
  }

  if (!user) {
    return <Navigate to="/" replace />;
  }

  if (roles && !roles.includes(user.role)) {
    return <Navigate to="/portal" replace />;
  }

  return <>{children}</>;
}
