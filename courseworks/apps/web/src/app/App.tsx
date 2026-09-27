/**
 * 文件作用：实现后端进程装配层中的 `HomeRedirect`、`App` 等能力。
 * 模块位置：`apps/web/src/app/App.tsx`，属于后端进程装配层。
 * 重要函数：`HomeRedirect()` 负责处理`home` `redirect`；`App()` 负责处理`app`。
 */
import { Navigate, Route, Routes } from "react-router-dom";

import { AuthGate } from "../features/auth/AuthGate";
import { useAuth } from "../features/auth/auth-context";
import { AdminPage } from "../features/admin/AdminPage";
import { AuthPage } from "../features/auth/AuthPage";
import { LabPage } from "../features/lab/LabPage";
import { WorkspacePage } from "../features/workspace/WorkspacePage";
import { ClassManagementPage } from "../features/classes/ClassManagementPage";
import { StudentClassesPage } from "../features/classes/StudentClassesPage";
import { TeacherClassSelectionPage } from "../features/classes/TeacherClassSelectionPage";
import { ServicePortalPage } from "../features/portal/ServicePortalPage";

/**
 * 功能：处理`home` `redirect`。
 * 输入：无显式输入参数。
 * 输出：返回 React 元素，供父组件渲染。
 * 调用关系：由 React 组件树或路由渲染过程调用；内部调用 `useAuth()`。
 */
function HomeRedirect() {
  // 根路由只负责把用户送到他真正该去的页面。
  const { hydrated, user } = useAuth();

  if (!hydrated) {
    return <div className="screen-center">正在加载...</div>;
  }

  if (!user) {
    return <AuthPage />;
  }

  return <Navigate to="/portal" replace />;
}

/**
 * 功能：处理`app`。
 * 输入：无显式输入参数。
 * 输出：返回 React 元素，供父组件渲染。
 * 调用关系：由 React 组件树或路由渲染过程调用。
 */
export function App() {
  // 前端的页面级路由总表。
  return (
    <Routes>
      <Route path="/" element={<HomeRedirect />} />
      <Route
        path="/portal"
        element={<AuthGate><ServicePortalPage /></AuthGate>}
      />
      <Route
        path="/admin"
        element={
          <AuthGate roles={["super_admin"]}>
            <AdminPage />
          </AuthGate>
        }
      />
      <Route
        path="/app"
        element={
          <AuthGate roles={["teacher", "ta", "student"]}>
            <WorkspacePage />
          </AuthGate>
        }
      />
      <Route
        path="/classes"
        element={
          <AuthGate roles={["teacher", "ta"]}>
            <ClassManagementPage />
          </AuthGate>
        }
      />
      <Route
        path="/student/classes"
        element={
          <AuthGate roles={["student", "ta"]}>
            <StudentClassesPage />
          </AuthGate>
        }
      />
      <Route
        path="/teacher/classes/select"
        element={
          <AuthGate roles={["teacher"]}>
            <TeacherClassSelectionPage />
          </AuthGate>
        }
      />
      <Route
        path="/lab"
        element={
          <AuthGate roles={["teacher", "ta", "student"]}>
            <LabPage />
          </AuthGate>
        }
      />
      <Route
        path="/lab/:runId"
        element={
          <AuthGate roles={["teacher", "ta", "student"]}>
            <LabPage />
          </AuthGate>
        }
      />
      <Route
        path="/review"
        element={
          <AuthGate roles={["teacher"]}>
            <WorkspacePage reviewMode />
          </AuthGate>
        }
      />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
