/**
 * 文件作用：实现后端“学生工作区”业务模块的核心操作。
 * 模块位置：`apps/server/src/modules/workspaces/import-export.service.ts`，属于后端“学生工作区”业务模块。
 * 重要函数：`normalizeWorkspaceRelativePath()` 负责规范化工作区 `relative` 路径；`normalizeArchiveEntryPath()` 负责规范化`archive` `entry` 路径；`sanitizeArchiveFileName()` 负责处理`sanitize` `archive` 文件 `name`；`detectArchiveKind()` 负责识别`archive` `kind`；`ensureSafeArchivePath()` 负责确保`safe` `archive` 路径；`pathExists()` 负责处理路径 `exists`；`findZipEndOfCentralDirectory()` 负责查找`zip` `end` `of` `central` 目录；`decodeZipEntryName()` 负责处理`decode` `zip` `entry` `name`。
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import { inflateRaw } from "node:zlib";

import { assertWorkspaceWriteAllowed } from "./workspace-disk-quota.service.js";
import { safePathResolve } from "./safe-path.service.js";

// 这个 service 专门处理“工作区级别”的压缩包导入/导出。
// 它和会话附件、Agent 产物下载是两条完全不同的能力链路。
const execFile = promisify(execFileCallback);
const inflateRawAsync = promisify(inflateRaw);

// 这些上限是当前实现采用的保守安全阈值，用来限制压缩包攻击面和误操作成本。
const MAX_ARCHIVE_BYTES = 80 * 1024 * 1024;
const MAX_EXTRACTED_BYTES = 250 * 1024 * 1024;
const MAX_SINGLE_FILE_BYTES = 20 * 1024 * 1024;
const MAX_ENTRY_COUNT = 4000;
const EMPTY_EXPORT_NOTE_NAME = "README.txt";
const EMPTY_EXPORT_NOTE = "This workspace export was empty when the ZIP was generated.\n";

export type WorkspaceImportMode = "archive-only" | "extract";
export type WorkspaceOverwritePolicy = "fail" | "merge" | "overwrite";
export type WorkspaceArchiveKind = "zip" | "tar.gz" | "tar.bz2";

export type WorkspaceImportArgs = {
  // 传入的参数尽量保持“平台语义”，不暴露底层 zip/tar 命令细节。
  workspacePath: string;
  originalName: string;
  archiveBuffer: Buffer;
  mode: WorkspaceImportMode;
  targetPath?: string;
  overwritePolicy?: WorkspaceOverwritePolicy;
};

export type WorkspaceImportSummary = {
  // 导入完成后的摘要会直接返回给前端弹窗展示。
  archiveName: string;
  archiveKind: WorkspaceArchiveKind;
  mode: WorkspaceImportMode;
  targetPath: string;
  overwritePolicy: WorkspaceOverwritePolicy;
  extracted: boolean;
  writtenFiles: string[];
  writtenCount: number;
  skippedFiles: string[];
  skippedCount: number;
  conflictFiles: string[];
  conflictCount: number;
  entryCount: number;
  totalBytes: number;
};

export type WorkspaceExportResult = {
  archivePath: string;
  downloadName: string;
  isEmptyExport: boolean;
};

type ArchiveEntry = {
  // 统一的压缩包条目描述，后面 zip 和 tar 都转成这一种结构处理。
  path: string;
  type: "file" | "directory" | "symlink" | "hardlink" | "other";
  size: number;
  executable: boolean;
};

type ZipEntry = ArchiveEntry & {
  // ZIP 解压需要保留中央目录里的原始定位信息，避免依赖系统 unzip 的文件名编码猜测。
  compressedSize: number;
  compressionMethod: number;
  localHeaderOffset: number;
};

const ZIP_EOCD_SIGNATURE = 0x06054b50;
const ZIP_CENTRAL_DIRECTORY_SIGNATURE = 0x02014b50;
const ZIP_LOCAL_FILE_HEADER_SIGNATURE = 0x04034b50;
const ZIP_UTF8_NAME_FLAG = 0x0800;

/**
 * 功能：规范化工作区 `relative` 路径。
 * 输入：`value`（string | null）提供value。
 * 输出：返回该操作生成、查询或转换后的结果；异步实现以 Promise 交付结果。
 * 调用关系：由 `apps/server/src/modules/workspaces/import-export.service.ts:importWorkspaceArchive()` 调用；内部调用 `replace()`。
 */
function normalizeWorkspaceRelativePath(value?: string | null) {
  // 把前端给的目标目录标准化成 workspace 内部相对路径。
  const raw = (value ?? "").trim().replace(/\\/g, "/");
  if (!raw || raw === "/" || raw === ".") return "";
  return raw.replace(/^\/+/, "").replace(/\/+$/, "");
}

/**
 * 功能：规范化`archive` `entry` 路径。
 * 输入：`value`（string）提供value。
 * 输出：返回该操作生成、查询或转换后的结果；异步实现以 Promise 交付结果。
 * 调用关系：由 `apps/server/src/modules/workspaces/import-export.service.ts:ensureSafeArchivePath()`、`apps/server/src/modules/workspaces/import-export.service.ts:collectExtractedFiles()` 调用；内部调用 `replace()`。
 */
function normalizeArchiveEntryPath(value: string) {
  return value.replace(/\\/g, "/").replace(/^\.\/+/, "").replace(/\/+$/, "");
}

/**
 * 功能：处理`sanitize` `archive` 文件 `name`。
 * 输入：`value`（string）提供value。
 * 输出：返回该操作生成、查询或转换后的结果；异步实现以 Promise 交付结果。
 * 调用关系：由 `apps/server/src/modules/workspaces/import-export.service.ts:importWorkspaceArchive()` 调用；内部调用 `basename()`、`replace()`。
 */
function sanitizeArchiveFileName(value: string) {
  const trimmed = path.basename(value || "workspace-import");
  const sanitized = trimmed.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+/, "");
  return sanitized || "workspace-import";
}

/**
 * 功能：识别`archive` `kind`。
 * 输入：`originalName`（string）提供original name。
 * 输出：返回 WorkspaceArchiveKind，供调用方继续处理。
 * 调用关系：由 `apps/server/src/modules/workspaces/import-export.service.ts:importWorkspaceArchive()` 调用；内部调用 `toLowerCase()`、`endsWith()`。
 */
function detectArchiveKind(originalName: string): WorkspaceArchiveKind {
  // 只认平台允许的少数压缩格式，避免把任意二进制都当归档来处理。
  const lower = originalName.toLowerCase();
  if (lower.endsWith(".zip")) return "zip";
  if (lower.endsWith(".tar.gz") || lower.endsWith(".tgz")) return "tar.gz";
  if (lower.endsWith(".tar.bz2") || lower.endsWith(".tbz2")) return "tar.bz2";
  throw new Error("不支持此压缩包格式。支持：.zip、.tar.gz、.tgz、.tar.bz2、.tbz2。");
}

/**
 * 功能：确保`safe` `archive` 路径。
 * 输入：`relativePath`（string）提供relative 路径。
 * 输出：返回该操作生成、查询或转换后的结果；异步实现以 Promise 交付结果。
 * 调用关系：由 `apps/server/src/modules/workspaces/import-export.service.ts:parseZipEntries()`、`apps/server/src/modules/workspaces/import-export.service.ts:listTarEntries()` 调用；内部调用 `normalizeArchiveEntryPath()`、`startsWith()`、`split()`、`some()`。
 */
function ensureSafeArchivePath(relativePath: string) {
  // 压缩包内路径必须是“纯相对路径”，这里是第一道 Zip Slip / Tar Slip 防线。
  const normalized = normalizeArchiveEntryPath(relativePath);
  if (!normalized) return null;
  if (normalized.startsWith("/")) throw new Error(`压缩包条目使用了绝对路径：${relativePath}`);
  const segments = normalized.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) {
    throw new Error(`压缩包条目超出工作区范围：${relativePath}`);
  }
  return normalized;
}

/**
 * 功能：处理路径 `exists`。
 * 输入：`target`（string）提供目标。
 * 输出：返回该操作生成、查询或转换后的结果；异步实现以 Promise 交付结果。
 * 调用关系：由 `apps/server/src/modules/workspaces/import-export.service.ts:importWorkspaceArchive()` 调用；内部调用 `lstat()`。
 */
async function pathExists(target: string) {
  try {
    await fs.lstat(target);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

/**
 * 功能：查找`zip` `end` `of` `central` 目录。
 * 输入：`buffer`（Buffer）提供buffer。
 * 输出：返回该操作生成、查询或转换后的结果；异步实现以 Promise 交付结果。
 * 调用关系：由 `apps/server/src/modules/workspaces/import-export.service.ts:parseZipEntries()` 调用；内部调用 `max()`、`readUInt32LE()`。
 */
function findZipEndOfCentralDirectory(buffer: Buffer) {
  // EOCD 最多带 64KiB comment，从文件尾向前扫描即可定位中央目录入口。
  const minimumOffset = Math.max(0, buffer.length - 65_557);
  for (let offset = buffer.length - 22; offset >= minimumOffset; offset -= 1) {
    if (buffer.readUInt32LE(offset) === ZIP_EOCD_SIGNATURE) return offset;
  }
  throw new Error("ZIP 压缩包无效：未找到中央目录结尾。");
}

/**
 * 功能：处理`decode` `zip` `entry` `name`。
 * 输入：`rawName`（Buffer）提供raw name。 `flags`（number）提供flags。
 * 输出：返回该操作生成、查询或转换后的结果；异步实现以 Promise 交付结果。
 * 调用关系：由 `apps/server/src/modules/workspaces/import-export.service.ts:parseZipEntries()` 调用；内部调用 `toString()`、`every()`、`decode()`。
 */
function decodeZipEntryName(rawName: Buffer, flags: number) {
  // ZIP 的通用位 11 表示文件名是 UTF-8；未设置时，中文 Windows ZIP 常见编码是 GBK/GB18030。
  if ((flags & ZIP_UTF8_NAME_FLAG) !== 0) return rawName.toString("utf8");
  if (rawName.every((byte) => byte < 0x80)) return rawName.toString("utf8");
  return new TextDecoder("gb18030").decode(rawName);
}

/**
 * 功能：解析`zip` `entries`。
 * 输入：`buffer`（Buffer）提供buffer。
 * 输出：返回 ZipEntry[]，供调用方继续处理。
 * 调用关系：由 `apps/server/src/modules/workspaces/import-export.service.ts:listZipEntries()`、`apps/server/src/modules/workspaces/import-export.service.ts:extractZipArchiveToTemp()` 调用；内部调用 `findZipEndOfCentralDirectory()`、`readUInt16LE()`、`readUInt32LE()`、`decodeZipEntryName()`、`subarray()`、`test()`。
 */
function parseZipEntries(buffer: Buffer): ZipEntry[] {
  // 只读取中央目录，不让系统 unzip 先落盘；这样可以保留原始文件名字节并自行解码。
  const eocdOffset = findZipEndOfCentralDirectory(buffer);
  const entryCount = buffer.readUInt16LE(eocdOffset + 10);
  const centralDirectorySize = buffer.readUInt32LE(eocdOffset + 12);
  const centralDirectoryOffset = buffer.readUInt32LE(eocdOffset + 16);
  if (centralDirectoryOffset + centralDirectorySize > buffer.length) {
    throw new Error("ZIP 压缩包无效：中央目录超出文件大小。");
  }

  const entries: ZipEntry[] = [];
  let offset = centralDirectoryOffset;
  for (let index = 0; index < entryCount; index += 1) {
    if (offset + 46 > buffer.length || buffer.readUInt32LE(offset) !== ZIP_CENTRAL_DIRECTORY_SIGNATURE) {
      throw new Error("ZIP 压缩包无效：中央目录条目格式错误。");
    }
    const flags = buffer.readUInt16LE(offset + 8);
    const compressionMethod = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const size = buffer.readUInt32LE(offset + 24);
    const fileNameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const externalAttributes = buffer.readUInt32LE(offset + 38);
    const localHeaderOffset = buffer.readUInt32LE(offset + 42);
    const nameStart = offset + 46;
    const nameEnd = nameStart + fileNameLength;
    if (nameEnd > buffer.length) {
      throw new Error("ZIP 压缩包无效：条目名称超出文件大小。");
    }
    const decodedPath = decodeZipEntryName(buffer.subarray(nameStart, nameEnd), flags);
    const entryLooksLikeDirectory = /\/+$/.test(decodedPath);
    const normalized = ensureSafeArchivePath(decodedPath);
    if (normalized) {
      const unixMode = externalAttributes >>> 16;
      const unixType = unixMode & 0o170000;
      if (compressedSize === 0xffffffff || size === 0xffffffff || localHeaderOffset === 0xffffffff) {
        throw new Error("暂不支持 ZIP64 压缩包。");
      }
      entries.push({
        path: normalized,
        type: entryLooksLikeDirectory || unixType === 0o040000 ? "directory" : unixType === 0o120000 ? "symlink" : "file",
        size,
        compressedSize,
        compressionMethod,
        localHeaderOffset,
        executable: (unixMode & 0o100) !== 0
      });
    }
    offset = nameEnd + extraLength + commentLength;
  }
  return entries;
}

/**
 * 功能：列出`zip` `entries`。
 * 输入：`archivePath`（string）提供archive 路径。
 * 输出：返回该操作生成、查询或转换后的结果；异步实现以 Promise 交付结果。
 * 调用关系：由 `apps/server/src/modules/workspaces/import-export.service.ts:importWorkspaceArchive()` 调用；内部调用 `parseZipEntries()`、`readFile()`。
 */
async function listZipEntries(archivePath: string) {
  return parseZipEntries(await fs.readFile(archivePath));
}

/**
 * 功能：提取`zip` `archive` `to` `temp`。
 * 输入：`archivePath`（string）提供archive 路径。 `tempDir`（string）提供temp dir。
 * 输出：返回该操作生成、查询或转换后的结果；异步实现以 Promise 交付结果。
 * 调用关系：由 `apps/server/src/modules/workspaces/import-export.service.ts:extractArchiveToTemp()` 调用；内部调用 `readFile()`、`parseZipEntries()`、`ensureDirectory()`、`readUInt32LE()`、`readUInt16LE()`、`subarray()`。
 */
async function extractZipArchiveToTemp(archivePath: string, tempDir: string) {
  const buffer = await fs.readFile(archivePath);
  const entries = parseZipEntries(buffer);
  for (const entry of entries) {
    const destination = path.join(tempDir, entry.path);
    if (entry.type === "directory") {
      await ensureDirectory(destination);
      continue;
    }
    if (entry.type !== "file") continue;
    if (entry.localHeaderOffset + 30 > buffer.length || buffer.readUInt32LE(entry.localHeaderOffset) !== ZIP_LOCAL_FILE_HEADER_SIGNATURE) {
      throw new Error(`ZIP 压缩包无效：${entry.path} 缺少本地文件头。`);
    }
    const localFileNameLength = buffer.readUInt16LE(entry.localHeaderOffset + 26);
    const localExtraLength = buffer.readUInt16LE(entry.localHeaderOffset + 28);
    const dataStart = entry.localHeaderOffset + 30 + localFileNameLength + localExtraLength;
    const dataEnd = dataStart + entry.compressedSize;
    if (dataEnd > buffer.length) {
      throw new Error(`ZIP 压缩包无效：${entry.path} 的压缩数据超出文件大小。`);
    }
    const compressed = buffer.subarray(dataStart, dataEnd);
    let payload: Buffer;
    if (entry.compressionMethod === 0) {
      payload = Buffer.from(compressed);
    } else if (entry.compressionMethod === 8) {
      payload = await inflateRawAsync(compressed);
    } else {
      throw new Error(`不支持 ZIP 压缩方法 ${entry.compressionMethod}：${entry.path}`);
    }
    if (payload.byteLength !== entry.size) {
      throw new Error(`ZIP 压缩包无效：${entry.path} 的解压大小不匹配。`);
    }
    await ensureDirectory(path.dirname(destination));
    await fs.writeFile(destination, payload, { mode: entry.executable ? 0o744 : 0o644 });
  }
}

/**
 * 功能：列出`tar` `entries`。
 * 输入：`archivePath`（string）提供archive 路径。 `kind`（WorkspaceArchiveKind）提供kind。
 * 输出：返回该操作生成、查询或转换后的结果；异步实现以 Promise 交付结果。
 * 调用关系：由 `apps/server/src/modules/workspaces/import-export.service.ts:importWorkspaceArchive()` 调用；内部调用 `execFile()`、`split()`、`match()`、`parseInt()`、`includes()`、`indexOf()`。
 */
async function listTarEntries(archivePath: string, kind: WorkspaceArchiveKind) {
  // tar 系列直接通过列表模式拿到路径、类型和大小。
  const args = kind === "tar.gz"
    ? ["-tvzf", archivePath]
    : ["-tvjf", archivePath];
  const { stdout } = await execFile("tar", args, { maxBuffer: 16 * 1024 * 1024 });
  const entries: ArchiveEntry[] = [];
  for (const line of stdout.split(/\r?\n/).filter(Boolean)) {
    const match = line.match(/^([\-dlh])[rwxstST-]{9}\s+\S+(?:\s+\S+)?\s+(\d+)\s+\S+\s+\S+\s+(.+)$/);
    if (!match) continue;
    const typeCode = match[1];
    const size = Number.parseInt(match[2], 10) || 0;
    const nameField = match[3].trim();
    const rawPath = typeCode === "l" && nameField.includes(" -> ") ? nameField.slice(0, nameField.indexOf(" -> ")) : nameField;
    const normalized = ensureSafeArchivePath(rawPath);
    if (!normalized) continue;
    entries.push({
      path: normalized,
      type: typeCode === "d" ? "directory" : typeCode === "l" ? "symlink" : typeCode === "h" ? "hardlink" : "file",
      size,
      executable: /^[\-dlh][rwx-]{2}x/.test(line)
    });
  }
  return entries;
}

/**
 * 功能：校验`archive` `entries`。
 * 输入：`entries`（ArchiveEntry[]）提供entries。
 * 输出：返回判断或校验结果；校验失败时可能抛出异常。
 * 调用关系：由 `apps/server/src/modules/workspaces/import-export.service.ts:importWorkspaceArchive()` 调用。
 */
function validateArchiveEntries(entries: ArchiveEntry[]) {
  // 在真正解压前先做一次“静态检查”，能更早失败就更早失败。
  if (!entries.length) throw new Error("压缩包为空。");
  if (entries.length > MAX_ENTRY_COUNT) throw new Error(`压缩包包含过多条目（${entries.length}/${MAX_ENTRY_COUNT}）。`);

  let totalBytes = 0;
  for (const entry of entries) {
    if (entry.type === "symlink" || entry.type === "hardlink") {
      throw new Error(`压缩包包含不支持的链接条目：${entry.path}`);
    }
    if (entry.type === "file") {
      if (entry.size > MAX_SINGLE_FILE_BYTES) {
        throw new Error(`压缩包条目过大：${entry.path}`);
      }
      totalBytes += entry.size;
    }
  }
  if (totalBytes > MAX_EXTRACTED_BYTES) {
    throw new Error(`压缩包解压后的数据量过大（${totalBytes} 字节）。`);
  }
  return totalBytes;
}

/**
 * 功能：提取`archive` `to` `temp`。
 * 输入：`archivePath`（string）提供archive 路径。 `kind`（WorkspaceArchiveKind）提供kind。 `tempDir`（string）提供temp dir。
 * 输出：返回该操作生成、查询或转换后的结果；异步实现以 Promise 交付结果。
 * 调用关系：由 `apps/server/src/modules/workspaces/import-export.service.ts:importWorkspaceArchive()` 调用；内部调用 `extractZipArchiveToTemp()`、`execFile()`。
 */
async function extractArchiveToTemp(archivePath: string, kind: WorkspaceArchiveKind, tempDir: string) {
  // 所有解压都先进入临时目录，校验通过后再复制进学生 workspace。
  if (kind === "zip") {
    await extractZipArchiveToTemp(archivePath, tempDir);
    return;
  }
  const args = kind === "tar.gz"
    ? ["-xzf", archivePath, "-C", tempDir, "--no-same-owner", "--no-same-permissions"]
    : ["-xjf", archivePath, "-C", tempDir, "--no-same-owner", "--no-same-permissions"];
  await execFile("tar", args, { maxBuffer: 16 * 1024 * 1024 });
}

/**
 * 功能：收集`extracted` 文件列表。
 * 输入：`root`（string）提供根目录。 `current`提供current。
 * 输出：返回 Promise<Array<{ relativePath: string; absolutePath: string; executable: boolean }>>，供调用方继续处理。
 * 调用关系：由 `apps/server/src/modules/workspaces/import-export.service.ts:collectExtractedFiles()`、`apps/server/src/modules/workspaces/import-export.service.ts:importWorkspaceArchive()` 调用；内部调用 `readdir()`、`isSymbolicLink()`、`isDirectory()`、`collectExtractedFiles()`、`isFile()`、`stat()`。
 */
async function collectExtractedFiles(root: string, current = ""): Promise<Array<{ relativePath: string; absolutePath: string; executable: boolean }>> {
  // 这里对“实际解压结果”再扫一遍，防止压缩包元数据和落盘结果不一致。
  const currentPath = path.join(root, current);
  const entries = await fs.readdir(currentPath, { withFileTypes: true });
  const files: Array<{ relativePath: string; absolutePath: string; executable: boolean }> = [];
  for (const entry of entries) {
    const relativePath = current ? `${current}/${entry.name}` : entry.name;
    const absolutePath = path.join(root, relativePath);
    if (entry.isSymbolicLink()) {
      throw new Error(`解压过程创建了符号链接：${relativePath}`);
    }
    if (entry.isDirectory()) {
      files.push(...await collectExtractedFiles(root, relativePath));
      continue;
    }
    if (!entry.isFile()) continue;
    const stat = await fs.stat(absolutePath);
    if (stat.size > MAX_SINGLE_FILE_BYTES) {
      throw new Error(`解压后的文件过大：${relativePath}`);
    }
    files.push({
      relativePath: normalizeArchiveEntryPath(relativePath),
      absolutePath,
      executable: (stat.mode & 0o100) !== 0
    });
  }
  return files;
}

/**
 * 功能：确保目录。
 * 输入：`target`（string）提供目标。
 * 输出：返回该操作生成、查询或转换后的结果；异步实现以 Promise 交付结果。
 * 调用关系：由 `apps/server/src/modules/workspaces/import-export.service.ts:extractZipArchiveToTemp()`、`apps/server/src/modules/workspaces/import-export.service.ts:copyImportedFile()`、`apps/server/src/modules/workspaces/import-export.service.ts:importWorkspaceArchive()`、`apps/server/src/modules/workspaces/import-export.service.ts:createWorkspaceExportZip()` 调用；内部调用 `mkdir()`。
 */
async function ensureDirectory(target: string) {
  await fs.mkdir(target, { recursive: true, mode: 0o755 });
}

/**
 * 功能：复制`imported` 文件。
 * 输入：`sourcePath`（string）提供source 路径。 `destinationPath`（string）提供destination 路径。 `executable`（boolean）提供executable。
 * 输出：返回该操作生成、查询或转换后的结果；异步实现以 Promise 交付结果。
 * 调用关系：由 `apps/server/src/modules/workspaces/import-export.service.ts:importWorkspaceArchive()` 调用；内部调用 `ensureDirectory()`、`dirname()`、`copyFile()`、`chmod()`。
 */
async function copyImportedFile(sourcePath: string, destinationPath: string, executable: boolean) {
  // 导入时统一规范化权限，避免直接继承归档里的 owner/group/perms。
  await ensureDirectory(path.dirname(destinationPath));
  await fs.copyFile(sourcePath, destinationPath);
  await fs.chmod(destinationPath, executable ? 0o744 : 0o644);
}

/**
 * 功能：格式化`import` 目标 路径。
 * 输入：`value`（string）提供value。
 * 输出：返回该操作生成、查询或转换后的结果；异步实现以 Promise 交付结果。
 * 调用关系：由 `apps/server/src/modules/workspaces/import-export.service.ts:importWorkspaceArchive()` 调用。
 */
function formatImportTargetPath(value: string) {
  return value ? `/${value}` : "/";
}

/**
 * 功能：处理`import` 工作区 `archive`。
 * 输入：`args`（WorkspaceImportArgs）提供args。
 * 输出：返回 Promise<WorkspaceImportSummary>，供调用方继续处理。
 * 调用关系：由 `apps/server/src/application/workspace/workspace-application.service.ts:importStudentWorkspace()`、`apps/server/src/modules/workspaces/import-export.service.test.ts 顶层流程` 调用；内部调用 `detectArchiveKind()`、`normalizeWorkspaceRelativePath()`、`safePathResolve()`、`mkdtemp()`、`tmpdir()`、`sanitizeArchiveFileName()`。
 */
export async function importWorkspaceArchive(args: WorkspaceImportArgs): Promise<WorkspaceImportSummary> {
  // 这是导入主流程：
  // 校验格式 -> 落临时文件 -> 列目录检查 -> 解压到临时目录 -> 冲突处理 -> 复制进 workspace。
  const archiveKind = detectArchiveKind(args.originalName);
  const overwritePolicy = args.overwritePolicy ?? "fail";
  const targetPath = normalizeWorkspaceRelativePath(args.targetPath);
  const safeTargetRoot = safePathResolve(args.workspacePath, targetPath || ".");

  if (args.archiveBuffer.byteLength > MAX_ARCHIVE_BYTES) {
    throw new Error(`压缩包超过 ${MAX_ARCHIVE_BYTES} 字节限制。`);
  }

  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "courseworks-import-"));
  const archiveName = sanitizeArchiveFileName(args.originalName);
  const archivePath = path.join(tempRoot, archiveName);
  await fs.writeFile(archivePath, args.archiveBuffer, { mode: 0o600 });

  try {
    if (args.mode === "archive-only") {
      // archive-only 不解压，只把归档文件当普通 workspace 文件保存。
      const destinationPath = path.join(safeTargetRoot, archiveName);
      if (overwritePolicy === "fail" && await pathExists(destinationPath)) {
        throw new Error(`目标文件已存在：${path.posix.join(targetPath, archiveName)}`);
      }
      const previousSize = await fs.stat(destinationPath).then((stat) => stat.size).catch(() => 0);
      await assertWorkspaceWriteAllowed(args.workspacePath, Math.max(0, args.archiveBuffer.byteLength - previousSize));
      await copyImportedFile(archivePath, destinationPath, false);
      return {
        archiveName,
        archiveKind,
        mode: args.mode,
        targetPath: formatImportTargetPath(targetPath),
        overwritePolicy,
        extracted: false,
        writtenFiles: [path.posix.join(targetPath, archiveName).replace(/^\/+/, "")],
        writtenCount: 1,
        skippedFiles: [],
        skippedCount: 0,
        conflictFiles: [],
        conflictCount: 0,
        entryCount: 1,
        totalBytes: args.archiveBuffer.byteLength
      };
    }

    const listedEntries = archiveKind === "zip"
      ? await listZipEntries(archivePath)
      : await listTarEntries(archivePath, archiveKind);
    const totalBytes = validateArchiveEntries(listedEntries);

    const extractRoot = path.join(tempRoot, "extracted");
    await ensureDirectory(extractRoot);
    await extractArchiveToTemp(archivePath, archiveKind, extractRoot);

    const extractedFiles = await collectExtractedFiles(extractRoot);
    if (extractedFiles.length > MAX_ENTRY_COUNT) {
      throw new Error(`压缩包解压出的文件过多（${extractedFiles.length}/${MAX_ENTRY_COUNT}）。`);
    }

    const conflicts: string[] = [];
    const skipped: string[] = [];
    const written: string[] = [];

    if (overwritePolicy === "fail") {
      // fail 模式在真正写入前先做一次全量冲突扫描，避免写到一半再失败。
      for (const file of extractedFiles) {
        const destinationPath = safePathResolve(args.workspacePath, path.posix.join(targetPath, file.relativePath));
        if (await pathExists(destinationPath)) {
          conflicts.push(path.posix.join(targetPath, file.relativePath).replace(/^\/+/, ""));
        }
      }
      if (conflicts.length) {
        throw new Error(`导入会覆盖已有文件：${conflicts.slice(0, 10).join(", ")}`);
      }
    }


    let additionalBytes = 0;
    for (const file of extractedFiles) {
      const destinationRelative = path.posix.join(targetPath, file.relativePath).replace(/^\/+/, "");
      const destinationPath = safePathResolve(args.workspacePath, destinationRelative || ".");
      const previous = await fs.stat(destinationPath).catch(() => null);
      if (previous && overwritePolicy === "merge") continue;
      const nextSize = await fs.stat(file.absolutePath).then((stat) => stat.size);
      additionalBytes += Math.max(0, nextSize - (previous?.size ?? 0));
    }
    await assertWorkspaceWriteAllowed(args.workspacePath, additionalBytes);

    for (const file of extractedFiles) {
      const destinationRelative = path.posix.join(targetPath, file.relativePath).replace(/^\/+/, "");
      const destinationPath = safePathResolve(args.workspacePath, destinationRelative || ".");
      const exists = await pathExists(destinationPath);
      if (exists && overwritePolicy === "merge") {
        skipped.push(destinationRelative);
        conflicts.push(destinationRelative);
        continue;
      }
      await copyImportedFile(file.absolutePath, destinationPath, file.executable);
      written.push(destinationRelative);
    }

    return {
      archiveName,
      archiveKind,
      mode: args.mode,
      targetPath: formatImportTargetPath(targetPath),
      overwritePolicy,
      extracted: true,
      writtenFiles: written,
      writtenCount: written.length,
      skippedFiles: skipped,
      skippedCount: skipped.length,
      conflictFiles: conflicts,
      conflictCount: conflicts.length,
      entryCount: listedEntries.length,
      totalBytes
    };
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true }).catch(() => undefined);
  }
}

/**
 * 功能：处理工作区 `has` 文件列表。
 * 输入：`workspacePath`（string）提供工作区 路径。
 * 输出：返回该操作生成、查询或转换后的结果；异步实现以 Promise 交付结果。
 * 调用关系：由 `apps/server/src/modules/workspaces/import-export.service.ts:createWorkspaceExportZip()` 调用；内部调用 `readdir()`。
 */
async function workspaceHasFiles(workspacePath: string) {
  const entries = await fs.readdir(workspacePath, { withFileTypes: true });
  return entries.length > 0;
}

/**
 * 功能：创建工作区 `export` `zip`。
 * 输入：`workspacePath`（string）提供工作区 路径。 `workspaceUuid`（string）提供工作区 uuid。
 * 输出：返回 Promise<WorkspaceExportResult>，供调用方继续处理。
 * 调用关系：由 `apps/server/src/application/workspace/workspace-application.service.ts:exportStudentWorkspace()`、`apps/server/src/modules/workspaces/import-export.service.test.ts 顶层流程` 调用；内部调用 `mkdtemp()`、`tmpdir()`、`workspaceHasFiles()`、`execFile()`、`ensureDirectory()`、`writeFile()`。
 */
export async function createWorkspaceExportZip(workspacePath: string, workspaceUuid: string): Promise<WorkspaceExportResult> {
  // 导出只打当前 workspace 的工程文件；如果为空，则生成带说明文件的空 ZIP。
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "courseworks-export-"));
  const archivePath = path.join(tempRoot, `workspace-${workspaceUuid}.zip`);
  const downloadName = `workspace-${workspaceUuid.slice(0, 8)}.zip`;
  const hasFiles = await workspaceHasFiles(workspacePath);

  if (hasFiles) {
    await execFile("zip", ["-rq", archivePath, "."], {
      cwd: workspacePath,
      maxBuffer: 16 * 1024 * 1024
    });
    return { archivePath, downloadName, isEmptyExport: false };
  }

  const emptyRoot = path.join(tempRoot, "empty");
  await ensureDirectory(emptyRoot);
  await fs.writeFile(path.join(emptyRoot, EMPTY_EXPORT_NOTE_NAME), EMPTY_EXPORT_NOTE, "utf8");
  await execFile("zip", ["-rq", archivePath, "."], {
    cwd: emptyRoot,
    maxBuffer: 16 * 1024 * 1024
  });
  return { archivePath, downloadName, isEmptyExport: true };
}
