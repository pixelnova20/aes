#!/usr/bin/env node
/** Generate README screenshots from isolated synthetic data. */

import { spawn } from "node:child_process";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";


const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUTPUT = join(ROOT, "docs", "pictures");
const VITE_URL = "http://127.0.0.1:5174";
const HOMEWORKS_URL = "http://127.0.0.1:5181";
const SLIDESHOW_URL = "http://127.0.0.1:5182";
const SYNTHETIC_TOKEN = "docs-synthetic-session";

async function loadPlaywright() {
  const candidates = [process.env.PLAYWRIGHT_MODULE].filter(Boolean);
  try {
    const npxCache = join(process.env.HOME || "", ".npm", "_npx");
    const entries = await readdir(npxCache, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory()) candidates.push(join(npxCache, entry.name, "node_modules", "playwright", "index.mjs"));
    }
  } catch {
    // The npx cache is optional; a project-local installation is preferred.
  }
  for (const candidate of candidates) {
    try {
      return await import(pathToFileURL(candidate).href);
    } catch {
      // Try the next known local installation.
    }
  }
  try {
    return await import("playwright");
  } catch {
    throw new Error("Playwright is required. Set PLAYWRIGHT_MODULE to playwright/index.mjs.");
  }
}

function start(command, args, cwd) {
  const child = spawn(command, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
  child.stdout.on("data", (chunk) => process.stdout.write(`[${command}] ${chunk}`));
  child.stderr.on("data", (chunk) => process.stderr.write(`[${command}] ${chunk}`));
  return child;
}

async function waitFor(url, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { redirect: "manual" });
      if (response.status < 500) return;
    } catch {
      // The development server may still be starting.
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 250));
  }
  throw new Error(`Timed out waiting for ${url}`);
}

function authUser(role) {
  if (role === "super_admin") {
    return {
      id: "docs-admin",
      email: "admin@example.edu",
      name: "系统管理员",
      studentNo: null,
      role,
      courseName: null,
      inviteCode: null,
      currentClass: null,
      workspace: null,
    };
  }
  const teacher = role === "teacher";
  return {
    id: teacher ? "docs-teacher" : "docs-student",
    email: teacher ? "teacher@example.edu" : "student@example.edu",
    name: teacher ? "陈老师" : "林同学",
    studentNo: teacher ? "T2026001" : "S20260001",
    role,
    courseName: "操作系统原理",
    inviteCode: { className: "操作系统实验班" },
    currentClass: { courseName: "操作系统原理", className: "操作系统实验班" },
    workspace: { status: "ready" },
  };
}

const profiles = [
  {
    id: "profile-deepseek",
    name: "DeepSeek V4 Pro",
    baseUrl: "https://deepseek.api.example/v1",
    model: "deepseek-v4-pro",
    level: "high",
    apiKeyConfigured: true,
    apiKeyMasked: "demo********key",
    selected: true,
    updatedAt: "2026-09-25T08:00:00.000Z",
  },
  {
    id: "profile-kimi",
    name: "Kimi K3",
    baseUrl: "https://kimi.api.example/v1",
    model: "kimi-k3",
    level: "medium",
    apiKeyConfigured: true,
    apiKeyMasked: "demo********key",
    selected: false,
    updatedAt: "2026-09-24T08:00:00.000Z",
  },
  {
    id: "profile-glm",
    name: "GLM-5.3",
    baseUrl: "https://glm.api.example/v1",
    model: "glm-5.3",
    level: "medium",
    apiKeyConfigured: true,
    apiKeyMasked: "demo********key",
    selected: false,
    updatedAt: "2026-09-23T08:00:00.000Z",
  },
];

function classProvider() {
  return {
    currentClass: {
      id: "class-os-demo",
      invitationCode: "DEMO-CLASS-2026",
      courseName: "操作系统原理",
      className: "操作系统实验班",
    },
    assignment: {
      profileId: "profile-deepseek",
      profileName: "DeepSeek V4 Pro",
      baseUrl: "https://deepseek.api.example/v1",
      model: "deepseek-v4-pro",
      level: "high",
      enforced: false,
      dailyTokenLimit: 60_000,
      quotaStatus: {
        usageDate: "2026-09-26",
        dailyTokenLimit: 60_000,
        usedTokens: 8_460,
        remainingTokens: 51_540,
      },
    },
  };
}

const workspace = {
  id: "workspace-docs",
  userId: "docs-student",
  workspaceUuid: "course-os-demo-2026",
  path: "/srv/aes/workspaces/docs-student",
  status: "ready",
  osType: "linux",
  targetArch: "riscv64",
  targetPlatform: "qemu-virt",
  createdAt: "2026-09-20T08:00:00.000Z",
  updatedAt: "2026-09-26T08:00:00.000Z",
};

const workspaceTree = [
  { name: "README.md", path: "README.md", type: "file" },
  {
    name: "kernel",
    path: "kernel",
    type: "directory",
    children: [
      { name: "main.c", path: "kernel/main.c", type: "file" },
      { name: "scheduler.c", path: "kernel/scheduler.c", type: "file" },
      { name: "trap.c", path: "kernel/trap.c", type: "file" },
    ],
  },
  { name: "Makefile", path: "Makefile", type: "file" },
];

const reviewTree = [
  {
    name: "S20260001",
    path: "S20260001",
    type: "directory",
    children: [
      {
        name: ".eva_history",
        path: "S20260001/.eva_history",
        type: "directory",
        children: [{ name: "run-summary.md", path: "S20260001/.eva_history/run-summary.md", type: "file" }],
      },
      {
        name: "project",
        path: "S20260001/project",
        type: "directory",
        children: [
          { name: "kernel", path: "S20260001/project/kernel", type: "directory", children: [
            { name: "main.c", path: "S20260001/project/kernel/main.c", type: "file" },
          ] },
          { name: "Makefile", path: "S20260001/project/Makefile", type: "file" },
        ],
      },
    ],
  },
  {
    name: "S20260002",
    path: "S20260002",
    type: "directory",
    children: [{ name: "project", path: "S20260002/project", type: "directory", children: [] }],
  },
];

function chatSnapshot(reviewMode = false) {
  if (reviewMode) {
    return {
      currentSessionId: "review-session",
      session: { sessionId: "review-session", title: "班级实验审阅", updatedAt: "2026-09-26T09:30:00.000Z" },
      sessions: [],
      history: [],
      contextUsage: { tokens: 0, contextWindow: 128000, percent: 0 },
    };
  }
  return {
    currentSessionId: "docs-session",
    session: { sessionId: "docs-session", title: "实现进程调度器", updatedAt: "2026-09-26T09:30:00.000Z" },
    sessions: [{ sessionId: "docs-session", title: "实现进程调度器", updatedAt: "2026-09-26T09:30:00.000Z", turnCount: 2, status: "active" }],
    history: [
      { id: "chat-user-1", role: "user", content: "请帮我检查时间片轮转调度器的实现思路。", createdAt: "2026-09-26T09:25:00.000Z" },
      { id: "chat-assistant-1", role: "assistant", content: "可以先核对就绪队列入队顺序，再检查时钟中断中对剩余时间片的更新。", createdAt: "2026-09-26T09:26:00.000Z" },
    ],
    contextUsage: { tokens: 3_240, contextWindow: 128_000, percent: 2.5 },
  };
}

function apiPayload(pathname, role, method) {
  const path = pathname.replace(/^\/api/, "");
  if (path === "/auth/me") return authUser(role);
  if (path === "/ai/profiles") {
    return {
      profiles: role === "student"
        ? profiles
            .filter((profile) => profile.id !== "profile-deepseek")
            .map((profile) => ({ ...profile, selected: false }))
        : profiles,
    };
  }
  if (path === "/ai/class-provider") return classProvider();
  if (path === "/workspace/status") return { workspace };
  if (path === "/workspace/tree") return { tree: workspaceTree };
  if (path === "/teacher/review/audit/tree") return { tree: reviewTree };
  if (path === "/ai/settings") return {
    settings: {
      configured: true,
      baseUrl: "https://deepseek.api.example/v1",
      apiKeyConfigured: true,
      apiKeyMasked: "demo********key",
      model: "deepseek-v4-pro",
      temperature: 0.3,
      contextWindowTokens: 128_000,
      reasoningEffort: "medium",
      reasoningEffortOptions: ["low", "medium", "high"],
    },
  };
  if (path === "/agent/runs") return { runs: [] };
  if (path.startsWith("/agent/chat-sessions/context-usage")) return { contextUsage: { tokens: 3_240, contextWindow: 128_000, percent: 2.5 } };
  if (path.startsWith("/agent/chat-sessions")) return { chat: chatSnapshot(path.includes("mode=review")) };
  if (path === "/agent/course-task") return { courseTask: { title: "实现一个支持时间片轮转的教学内核", subtasks: [
    { title: "初始化进程控制块", lastBuildStatus: "success", lastQemuStatus: "success" },
    { title: "实现调度器", lastBuildStatus: "pending", lastQemuStatus: "pending" },
  ] } };
  if (path === "/workspace/uploads") return { uploads: [] };
  if (path === "/teacher/class-progress") return { classes: [] };
  if (path === "/workspace/lab" || path === "/workspace/lab/reset" || path === "/workspace/lab/shells") {
    const session = {
      runId: "docs-shell-1",
      status: "idle",
      output: "AES OS Lab documentation session\r\nbash-5.2$ make\r\nBuild completed: kernel.elf\r\nbash-5.2$ ",
      exitCode: null,
      startedAt: "2026-09-26T09:00:00.000Z",
      finishedAt: null,
    };
    return path.endsWith("shells")
      ? { session }
      : {
          session,
          ...(path === "/workspace/lab" ? { shells: [session] } : {}),
          workspace: { workspaceUuid: "course-os-demo-2026" },
          limits: { maxShells: 5 },
        };
  }
  if (path.startsWith("/workspace/lab/vnc-status")) return { status: { state: "waiting_for_qemu", message: "等待 QEMU 图形输出。" } };
  if (path === "/admin/summary") return { users: 24, inviteCodes: 6, workspaces: 18 };
  if (path === "/admin/users") return { users: [
    { id: "docs-admin", email: "admin@example.edu", name: "系统管理员", role: "super_admin", studentNo: null, courseName: null, isActive: true, className: null, workspaceStatus: null, aiProviderConfigured: false, targetArch: null },
    { id: "docs-teacher", email: "teacher@example.edu", name: "陈老师", role: "teacher", studentNo: "T2026001", courseName: "操作系统原理", isActive: true, className: "操作系统实验班", workspaceStatus: "ready", aiProviderConfigured: true, targetArch: "riscv64" },
    { id: "docs-student", email: "student@example.edu", name: "林同学", role: "student", studentNo: "S20260001", courseName: "操作系统原理", isActive: true, className: "操作系统实验班", workspaceStatus: "ready", aiProviderConfigured: true, targetArch: "riscv64" },
  ] };
  if (path === "/admin/invite-codes") return { inviteCodes: [
    { id: "invite-1", code: "TEACHER-DEMO", description: "操作系统课程教师", level: "level_1", parentCode: null, courseName: null, className: null, teacher: null, usedCount: 1, maxUses: 1, isActive: true, relatedUserCount: 4 },
  ] };
  if (path === "/admin/workspaces") return { workspaces: [
    { id: "workspace-1", email: "student@example.edu", role: "student", workspaceStatus: "ready", osType: "linux", targetArch: "riscv64", targetPlatform: "qemu-virt", path: "/srv/aes/workspaces/docs-student" },
  ] };
  if (path === "/admin/agent-runs") return { runs: [] };
  if (method !== "GET") return {};
  return null;
}

async function mockCourseworks(page, role) {
  await page.addInitScript(({ token }) => {
    localStorage.setItem("courseworks-token", token);
    localStorage.setItem("courseworks-workbench-theme", "light");
  }, { token: SYNTHETIC_TOKEN });
  await page.route("**/*", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (!url.pathname.startsWith("/api/")) return route.continue();
    const payload = apiPayload(`${url.pathname}${url.search}`, role, request.method());
    if (payload === null) {
      return route.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({ message: `Docs mock missing: ${url.pathname}` }) });
    }
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(payload) });
  });
}

async function stabilize(page) {
  await page.addStyleTag({ content: "*, *::before, *::after { animation: none !important; transition: none !important; caret-color: transparent !important; }" });
  await page.evaluate(async () => {
    if (document.fonts?.ready) await document.fonts.ready;
    window.scrollTo(0, 0);
  });
  await page.waitForTimeout(350);
}

async function screenshot(page, name, { fullPage = false } = {}) {
  await stabilize(page);
  const pageText = await page.locator("body").innerText();
  const forbidden = [
    /gpt/i,
    /hust\.edu\.cn/i,
    /222\.20\.98\.153/,
    /8\.148\.72\.30/,
  ];
  const matchedForbidden = forbidden.find((pattern) => pattern.test(pageText));
  if (matchedForbidden) {
    throw new Error(`${name} contains forbidden documentation text: ${matchedForbidden}`);
  }
  const unexpectedEmail = pageText
    .match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+/gi)
    ?.find((email) => !email.toLowerCase().endsWith("@example.edu"));
  if (unexpectedEmail) {
    throw new Error(`${name} contains a non-example email address: ${unexpectedEmail}`);
  }
  await page.screenshot({ path: join(OUTPUT, name), fullPage });
  process.stdout.write(`generated docs/pictures/${name}\n`);
}

async function newCourseworksPage(browser, role, path, viewport = { width: 1600, height: 900 }) {
  const page = await browser.newPage({ viewport, deviceScaleFactor: 1 });
  await mockCourseworks(page, role);
  await page.goto(`${VITE_URL}${path}`, { waitUntil: "networkidle" });
  return page;
}

async function generate(browser) {
  let page = await browser.newPage({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 1 });
  await page.goto(VITE_URL, { waitUntil: "networkidle" });
  await screenshot(page, "login.png");
  await page.close();

  page = await newCourseworksPage(browser, "super_admin", "/admin");
  await page.getByRole("heading", { name: "概览" }).waitFor();
  await screenshot(page, "admin-console.png");
  await page.close();

  page = await newCourseworksPage(browser, "teacher", "/portal");
  await page.getByText("DeepSeek V4 Pro", { exact: true }).first().waitFor();
  await screenshot(page, "portal-teacher.png");
  await page.close();

  page = await newCourseworksPage(browser, "student", "/portal", { width: 1600, height: 1120 });
  await page.getByRole("button", { name: "管理" }).click();
  await page.getByText("Provider Profiles", { exact: true }).waitFor();
  await screenshot(page, "provider-profiles.png", { fullPage: true });
  await page.close();

  page = await newCourseworksPage(browser, "student", "/portal");
  await page.getByText("教学服务", { exact: true }).waitFor();
  await screenshot(page, "portal-student.png");
  await page.close();

  page = await newCourseworksPage(browser, "student", "/app");
  await page.getByText("Courseworks", { exact: true }).first().waitFor();
  await screenshot(page, "courseworks.png");
  await page.close();

  page = await newCourseworksPage(browser, "teacher", "/review");
  await page.getByText("Courseworks 审阅", { exact: true }).waitFor();
  await screenshot(page, "courseworks-audit.png");
  await page.close();

  page = await newCourseworksPage(browser, "student", "/lab");
  await page.getByText("操作系统实验工作区", { exact: true }).waitFor();
  await screenshot(page, "os-lab.png");
  await page.close();

  page = await newCourseworksPage(browser, "teacher", "/portal", { width: 1600, height: 960 });
  await page.getByRole("button", { name: "班级设置" }).click();
  await page.getByRole("dialog").waitFor();
  await screenshot(page, "teacher-class-provider-quota-dialog.png");
  await page.close();

  page = await browser.newPage({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 1 });
  await page.goto(`${SLIDESHOW_URL}/__docs/login`, { waitUntil: "networkidle" });
  await screenshot(page, "slideshow.png");
  await page.close();

  page = await browser.newPage({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 1 });
  await page.goto(`${HOMEWORKS_URL}/__docs/login/student`, { waitUntil: "networkidle" });
  await screenshot(page, "homeworks-student.png", { fullPage: true });
  await page.close();

  page = await browser.newPage({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 1 });
  await page.goto(`${HOMEWORKS_URL}/__docs/login/teacher`, { waitUntil: "networkidle" });
  await screenshot(page, "homeworks-grading.png", { fullPage: true });
  await page.close();
}

async function main() {
  const dataRoot = await mkdtemp(join(tmpdir(), "aes-doc-screenshots-"));
  const children = [];
  let browser;
  try {
    children.push(start(resolve(ROOT, "courseworks/node_modules/.bin/vite"), ["--host", "127.0.0.1", "--port", "5174"], resolve(ROOT, "courseworks/apps/web")));
    children.push(start("python3", [resolve(ROOT, "scripts/docs_fixture_server.py"), "homeworks", "--data-root", dataRoot, "--port", "5181"], ROOT));
    children.push(start("python3", [resolve(ROOT, "scripts/docs_fixture_server.py"), "slideshow", "--data-root", dataRoot, "--port", "5182"], ROOT));
    await Promise.all([waitFor(VITE_URL), waitFor(`${HOMEWORKS_URL}/__docs/login/student`), waitFor(`${SLIDESHOW_URL}/__docs/login`)]);
    const { chromium } = await loadPlaywright();
    browser = await chromium.launch({ headless: true, executablePath: "/usr/bin/google-chrome", args: ["--no-sandbox"] });
    await generate(browser);
  } finally {
    if (browser) await browser.close();
    for (const child of children) child.kill("SIGTERM");
    await rm(dataRoot, { recursive: true, force: true });
  }
}

await main();
