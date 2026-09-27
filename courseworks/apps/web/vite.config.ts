/**
 * 文件作用：加载、校验并导出 Courseworks 运行配置。
 * 模块位置：`apps/web/vite.config.ts`，属于Courseworks 应用源码。
 * 重要函数：本文件以类型、常量、导出装配或启动副作用为主，不包含独立具名函数。
 */
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  build: {
    target: "esnext",
    outDir: "dist",
    emptyOutDir: true
  },
  optimizeDeps: {
    esbuildOptions: {
      target: "esnext"
    }
  },
  server: {
    port: 5173,
    proxy: {
      "/api": {
        target: "http://127.0.0.1:3000",
        changeOrigin: true
      }
    }
  }
});
