/**
 * 文件作用：提供Courseworks 应用源码所需的声明和装配。
 * 模块位置：`apps/web/src/main.tsx`，属于Courseworks 应用源码。
 * 重要函数：本文件以类型、常量、导出装配或启动副作用为主，不包含独立具名函数。
 */
import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter } from "react-router-dom";

import { App } from "./app/App";
import { AuthProvider } from "./features/auth/auth-context";
import "./app/styles.css";

// 前端启动入口：挂路由、挂认证上下文、再渲染整棵应用树。
ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <BrowserRouter>
      <AuthProvider>
        <App />
      </AuthProvider>
    </BrowserRouter>
  </React.StrictMode>
);
