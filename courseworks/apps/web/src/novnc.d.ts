/**
 * 文件作用：定义Courseworks 应用源码使用的数据结构与类型契约。
 * 模块位置：`apps/web/src/novnc.d.ts`，属于Courseworks 应用源码。
 * 重要函数：本文件以类型、常量、导出装配或启动副作用为主，不包含独立具名函数。
 */
declare module "@novnc/novnc" {
  export default class RFB extends EventTarget {
    /**
     * 功能：初始化 noVNC RFB 实例及其连接参数。
     * 输入：`target`（HTMLElement）提供目标。 `url`（string）提供url。 `options`（{ shared?: boolean }）提供options。
     * 输出：返回该操作生成、查询或转换后的结果；异步实现以 Promise 交付结果。
     * 调用关系：由创建该类实例的代码自动调用。
     */
    constructor(target: HTMLElement, url: string, options?: { shared?: boolean });
    scaleViewport: boolean;
    background: string;
    addEventListener(type: "connect", listener: (event: Event) => void): void;
    addEventListener(type: "disconnect", listener: (event: CustomEvent<{ clean?: boolean }>) => void): void;
    addEventListener(type: "securityfailure" | "credentialsrequired", listener: (event: Event) => void): void;
    /**
     * 功能：处理`disconnect`。
     * 输入：无显式输入参数。
     * 输出：返回 void，供调用方继续处理。
     * 调用关系：由 `apps/web/src/features/lab/LabPage.tsx:LabPage()` 调用。
     */
    disconnect(): void;
  }
}
