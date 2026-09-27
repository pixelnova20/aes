/**
 * 文件作用：实现工程运维脚本层中的 `fail`、`readJson`、`sourceFiles` 等能力。
 * 模块位置：`scripts/check-dependencies.mjs`，属于工程运维脚本层。
 * 重要函数：`fail()` 负责处理`fail`；`readJson()` 负责读取`json`；`sourceFiles()` 负责处理`source` 文件列表；`moduleName()` 负责处理`module` `name`；`checkArchitectureBoundaries()` 负责处理`check` `architecture` `boundaries`。
 */
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const manifests = [
  "package.json",
  "apps/server/package.json",
  "apps/web/package.json"
];
const serverSourceRoot = path.join(root, "apps/server/src");
const modulesRoot = path.join(serverSourceRoot, "modules");

/**
 * 功能：处理`fail`。
 * 输入：`message`提供消息。
 * 输出：返回该操作生成、查询或转换后的结果；异步实现以 Promise 交付结果。
 * 调用关系：由 `apps/server/src/modules/ai-settings/local-model-catalog.service.test.ts 顶层流程`、`apps/server/src/modules/coding-agent/adapters/pi/pi-coding-agent-runtime.ts:run()`、`scripts/check-dependencies.mjs:checkArchitectureBoundaries()`、`scripts/check-dependencies.mjs:visitModule()`、`scripts/check-dependencies.mjs 顶层流程` 调用；内部调用 `error()`。
 */
function fail(message) {
  console.error(`Dependency check failed: ${message}`);
  process.exitCode = 1;
}

/**
 * 功能：读取`json`。
 * 输入：`relativePath`提供relative 路径。
 * 输出：返回该操作生成、查询或转换后的结果；异步实现以 Promise 交付结果。
 * 调用关系：由 `scripts/check-dependencies.mjs 顶层流程` 调用；内部调用 `parse()`、`readFileSync()`。
 */
function readJson(relativePath) {
  return JSON.parse(fs.readFileSync(path.join(root, relativePath), "utf8"));
}

/**
 * 功能：处理`source` 文件列表。
 * 输入：`directory`提供目录。
 * 输出：返回该操作生成、查询或转换后的结果；异步实现以 Promise 交付结果。
 * 调用关系：由 `scripts/check-dependencies.mjs:sourceFiles()`、`scripts/check-dependencies.mjs:checkArchitectureBoundaries()` 调用；内部调用 `flatMap()`、`readdirSync()`、`isDirectory()`、`sourceFiles()`、`test()`。
 */
function sourceFiles(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(entryPath);
    return /\.(?:ts|tsx)$/.test(entry.name) ? [entryPath] : [];
  });
}

/**
 * 功能：处理`module` `name`。
 * 输入：`filePath`提供文件 路径。
 * 输出：返回该操作生成、查询或转换后的结果；异步实现以 Promise 交付结果。
 * 调用关系：由 `scripts/check-dependencies.mjs:checkArchitectureBoundaries()` 调用；内部调用 `relative()`、`startsWith()`、`split()`。
 */
function moduleName(filePath) {
  const relativePath = path.relative(modulesRoot, filePath);
  if (relativePath.startsWith("..")) return null;
  return relativePath.split(path.sep)[0] ?? null;
}

/**
 * 功能：处理`check` `architecture` `boundaries`。
 * 输入：无显式输入参数。
 * 输出：返回该操作生成、查询或转换后的结果；异步实现以 Promise 交付结果。
 * 调用关系：由 `scripts/check-dependencies.mjs 顶层流程` 调用；内部调用 `readdirSync()`、`isDirectory()`、`existsSync()`、`fail()`、`sourceFiles()`、`readFileSync()`。
 */
function checkArchitectureBoundaries() {
  const moduleDirectories = fs.readdirSync(modulesRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);
  const moduleDependencies = new Map(
    moduleDirectories.map((name) => [name, new Set()]),
  );
  for (const name of moduleDirectories) {
    if (!fs.existsSync(path.join(modulesRoot, name, "index.ts"))) {
      fail(`server module ${name} must expose an index.ts public API.`);
    }
  }

  for (const filePath of sourceFiles(serverSourceRoot)) {
    const source = fs.readFileSync(filePath, "utf8");
    const importerModule = moduleName(filePath);
    const relativeFile = path.relative(root, filePath);
    if (
      filePath.includes(`${path.sep}infrastructure${path.sep}`)
      && filePath.endsWith(".router.ts")
    ) {
      fail(`${relativeFile} is an HTTP adapter and belongs in the transport layer.`);
    }
    const imports = source.matchAll(/(?:from\s+|import\s*)["']([^"']+)["']/g);
    for (const match of imports) {
      const specifier = match[1];
      if (specifier.startsWith("@earendil-works/pi-")) {
        const piAdapterRoot = path.join(modulesRoot, "coding-agent", "adapters", "pi");
        if (!filePath.startsWith(`${piAdapterRoot}${path.sep}`)) {
          fail(`${relativeFile} imports ${specifier} outside the Pi adapter.`);
        }
      }
      if (
        specifier === "@prisma/client"
        && filePath.includes(`${path.sep}transport${path.sep}`)
      ) {
        fail(`${relativeFile} must not expose Prisma types in the transport layer.`);
      }
      if (!specifier.startsWith(".")) continue;
      const targetPath = path.resolve(path.dirname(filePath), specifier);
      if (
        filePath.includes(`${path.sep}transport${path.sep}`)
        && targetPath.includes(`${path.sep}infrastructure${path.sep}prisma${path.sep}`)
      ) {
        fail(`${relativeFile} must access persistence through an application service.`);
      }
      if (
        importerModule
        && (targetPath.includes(`${path.sep}application${path.sep}`)
          || targetPath.includes(`${path.sep}transport${path.sep}`))
      ) {
        fail(`${relativeFile} violates the modules -> application -> transport dependency direction.`);
      }
      const targetModule = moduleName(targetPath);
      if (!targetModule || targetModule === importerModule) continue;
      moduleDependencies.get(importerModule)?.add(targetModule);
      if (path.basename(targetPath) !== "index.js") {
        fail(
          `${relativeFile} reaches into module ${targetModule}; import its index.js public API instead.`,
        );
      }
    }
  }

  const visited = new Set();
  const active = [];
  /**
   * 功能：处理`visit` `module`。
   * 输入：`name`提供name。
   * 输出：返回该操作生成、查询或转换后的结果；异步实现以 Promise 交付结果。
   * 调用关系：由 `scripts/check-dependencies.mjs:visitModule()`、`scripts/check-dependencies.mjs:checkArchitectureBoundaries()` 调用；内部调用 `indexOf()`、`fail()`、`has()`、`visitModule()`、`pop()`、`add()`。
   */
  function visitModule(name) {
    const cycleStart = active.indexOf(name);
    if (cycleStart >= 0) {
      fail(`server module dependency cycle: ${[...active.slice(cycleStart), name].join(" -> ")}.`);
      return;
    }
    if (visited.has(name)) return;
    active.push(name);
    for (const dependency of moduleDependencies.get(name) ?? []) visitModule(dependency);
    active.pop();
    visited.add(name);
  }
  for (const name of moduleDirectories) visitModule(name);
}

for (const relativePath of ["apps/server/package-lock.json", "apps/web/package-lock.json"]) {
  if (fs.existsSync(path.join(root, relativePath))) {
    fail(`${relativePath} must not exist; use the root lockfile.`);
  }
}

const rootPackage = readJson("package.json");
const lock = readJson("package-lock.json");
if (lock.lockfileVersion !== 3) {
  fail(`expected package-lock.json lockfileVersion 3, got ${lock.lockfileVersion}.`);
}
if (JSON.stringify(rootPackage.workspaces) !== JSON.stringify(["apps/server", "apps/web"])) {
  fail("root workspaces must contain apps/server and apps/web.");
}

for (const manifestPath of manifests) {
  const manifest = readJson(manifestPath);
  for (const group of ["dependencies", "devDependencies"]) {
    for (const [name, version] of Object.entries(manifest[group] ?? {})) {
      if (/^[~^*]|[<>=| ]/.test(version)) {
        fail(`${manifestPath} must pin ${name} to an exact version, found ${version}.`);
      }
    }
  }
}

const serverPackage = readJson("apps/server/package.json");
const piDependencies = [
  "@earendil-works/pi-agent-core",
  "@earendil-works/pi-ai",
  "@earendil-works/pi-coding-agent"
];
const piVersions = new Set(piDependencies.map((name) => serverPackage.dependencies[name]));
if (piVersions.size !== 1 || piVersions.has(undefined)) {
  fail("all Pi packages must use the same exact version.");
}

const nestedBrace =
  lock.packages?.["node_modules/@earendil-works/pi-coding-agent/node_modules/brace-expansion"];
if (nestedBrace?.version === "5.0.7") {
  console.warn(
    "Known upstream warning: Pi coding-agent shrinkwrap pins brace-expansion 5.0.7."
  );
}

checkArchitectureBoundaries();

if (!process.exitCode) {
  console.log(
    `Dependency layout is valid: one lockfile, exact direct versions, Pi ${[...piVersions][0]}.`
  );
}
