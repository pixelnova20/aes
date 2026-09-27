/**
 * Runs optional, Agent-controlled QEMU display sessions and captures their real framebuffer through QMP.
 * The service never decides whether a student project should have graphics; callers opt in explicitly.
 */
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { deflateSync } from "node:zlib";

import { config } from "../../config/index.js";
import { assertWorkspaceExecutionAllowed, assertWorkspaceRoot, courseworksStateRoot } from "../workspaces/index.js";
import { tryAcquireExecutionAdmission, type ExecutionAdmissionLease } from "./execution-admission.service.js";
import { getContainerRunProfile, managedContainerLabelArgs, resourceArgs, securityArgs } from "./container-run-profile.js";
import { noteContainerOutput, noteContainerProgress, registerManagedContainer, resourceLimitMessage, unregisterManagedContainer, type ResourceLimitReason } from "./container-resource-monitor.service.js";

const QMP_SOCKET = "/tmp/courseworks-agent-qmp.sock";
const QMP_CAPTURE = "/tmp/courseworks-agent-display.ppm";
const MAX_OUTPUT = 128 * 1024;
const MAX_COMMAND_LENGTH = 8_192;
const MAX_FRAME_PIXELS = 8_388_608;
const MAX_CAPTURES_PER_SESSION = 20;
const CAPTURE_ROOT = "qemu-display-captures";
const UNPRIVILEGED_PING_SYSCTL = "net.ipv4.ping_group_range=0 2147483647";

export type GraphicalQemuSessionStatus = "running" | "stopped" | "failed" | "timeout" | "error" | "resource_limit_exceeded" | "idle_timeout";

export type GraphicalQemuSessionSnapshot = {
  sessionId: string;
  status: GraphicalQemuSessionStatus;
  qmpReady: boolean;
  output: string;
  exitCode: number | null;
  startedAt: string;
  finishedAt: string | null;
};

export type QemuDisplayCapture = {
  width: number;
  height: number;
  frameHash: string;
  meanBrightness: number;
  darkPixelRatio: number;
  uniqueColorEstimate: number;
  uniformFrame: boolean;
  changedPixelRatio: number | null;
  asciiPreview: string;
  storedPath: string;
  pngBase64: string;
};

type ActiveGraphicalQemuSession = {
  sessionId: string;
  containerName: string;
  workspacePath: string;
  child: ReturnType<typeof spawn>;
  status: GraphicalQemuSessionStatus;
  output: string;
  exitCode: number | null;
  startedAt: Date;
  finishedAt: Date | null;
  timer: NodeJS.Timeout;
  previousFrame: Buffer | null;
  lease: ExecutionAdmissionLease;
  limitReason: ResourceLimitReason | null;
};

const sessions = new Map<string, ActiveGraphicalQemuSession>();

const QMP_CLIENT = String.raw`
import json, socket, sys
s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
s.settimeout(4)
s.connect(sys.argv[1])
f = s.makefile("rwb", buffering=0)

def receive_reply():
    while True:
        line = f.readline()
        if not line:
            raise RuntimeError("QMP connection closed")
        message = json.loads(line.decode("utf-8"))
        if "return" in message or "error" in message:
            return message

f.readline()
f.write((json.dumps({"execute": "qmp_capabilities"}) + "\n").encode("utf-8"))
capabilities = receive_reply()
if "error" in capabilities:
    print(json.dumps(capabilities))
    sys.exit(2)
command = json.loads(sys.argv[2])
f.write((json.dumps(command) + "\n").encode("utf-8"))
reply = receive_reply()
print(json.dumps(reply))
sys.exit(2 if "error" in reply else 0)
`;

function appendOutput(session: ActiveGraphicalQemuSession, chunk: Buffer | string) {
  const text = typeof chunk === "string" ? chunk : chunk.toString();
  session.output = (session.output + text).slice(-MAX_OUTPUT);
  noteContainerOutput(session.containerName, Buffer.byteLength(text));
  noteContainerProgress(session.containerName);
}

function forceRemoveContainer(containerName: string) {
  const child = spawn("docker", ["rm", "-f", containerName], { shell: false, stdio: "ignore" });
  child.on("error", () => undefined);
}

function dockerArgs(containerName: string, workspacePath: string, command: string) {
  const profile = getContainerRunProfile("qemu");
  return [
    "run", "--rm", "-i", "--init",
    "--name", containerName,
    ...managedContainerLabelArgs({ purpose: "qemu", sessionId: containerName }),
    "--network", config.DOCKER_RESTRICTED_NETWORK,
    "--sysctl", UNPRIVILEGED_PING_SYSCTL,
    "--read-only",
    "--tmpfs", "/tmp:rw,exec,nosuid,nodev,size=128m",
    ...resourceArgs(profile),
    ...securityArgs(),
    "-e", "HOME=/tmp/runner",
    "-e", "XDG_CONFIG_HOME=/tmp/runner/.config",
    "-e", "XDG_DATA_HOME=/tmp/runner/.local/share",
    "-e", "XDG_CACHE_HOME=/tmp/runner/.cache",
    "-e", "XDG_STATE_HOME=/tmp/runner/.local/state",
    "-e", `COURSEWORKS_QMP_SOCKET=${QMP_SOCKET}`,
    "-v", `${workspacePath}:/home/runner/project:rw`,
    "-w", "/home/runner/project",
    config.DOCKER_TOOLBOX_IMAGE,
    "sh", "-lc", command,
  ];
}

function snapshot(session: ActiveGraphicalQemuSession): GraphicalQemuSessionSnapshot {
  return {
    sessionId: session.sessionId,
    status: session.status,
    qmpReady: false,
    output: session.output,
    exitCode: session.exitCode,
    startedAt: session.startedAt.toISOString(),
    finishedAt: session.finishedAt?.toISOString() ?? null,
  };
}

async function runProcess(command: string, args: string[]) {
  return new Promise<{ exitCode: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(command, args, { shell: false, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    child.on("error", reject);
    child.on("close", (exitCode) => resolve({ exitCode, stdout, stderr }));
  });
}

async function qmpCommand(session: ActiveGraphicalQemuSession, command: Record<string, unknown>) {
  const result = await runProcess("docker", [
    "exec", "--user", "1000:1000", session.containerName,
    "python3", "-c", QMP_CLIENT, QMP_SOCKET, JSON.stringify(command),
  ]);
  if (result.exitCode !== 0) {
    throw new Error((result.stderr || result.stdout).trim() || "QMP command failed.");
  }
  const response = JSON.parse(result.stdout.trim()) as { error?: { desc?: string }; return?: unknown };
  if (response.error) throw new Error(response.error.desc || "QMP command failed.");
  return response.return;
}

async function isQmpReady(session: ActiveGraphicalQemuSession) {
  if (session.status !== "running") return false;
  const result = await runProcess("docker", [
    "exec", "--user", "1000:1000", session.containerName,
    "test", "-S", QMP_SOCKET,
  ]).catch(() => null);
  return result?.exitCode === 0;
}

export async function waitForGraphicalQemuSession(sessionId: string, waitSeconds = 3) {
  const session = sessions.get(sessionId);
  if (!session) throw new Error("QEMU display session does not exist.");
  const deadline = Date.now() + Math.max(0, Math.min(waitSeconds, 30)) * 1000;
  let ready = await isQmpReady(session);
  while (!ready && session.status === "running" && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 200));
    ready = await isQmpReady(session);
  }
  return { ...snapshot(session), qmpReady: ready };
}

export async function startGraphicalQemuSession(args: {
  sessionId: string;
  workspacePath: string;
  command: string;
  timeoutSeconds?: number;
}) {
  assertWorkspaceRoot(args.workspacePath);
  const command = args.command.trim();
  if (!command) throw new Error("A QEMU startup command is required.");
  if (command.length > MAX_COMMAND_LENGTH) throw new Error("QEMU startup command is too long.");
  const existing = sessions.get(args.sessionId);
  if (existing?.status === "running") throw new Error("A QEMU display session is already running.");

  const workspacePath = path.resolve(args.workspacePath);
  await assertWorkspaceExecutionAllowed(workspacePath);
  const containerName = `courseworks-agent-display-${randomUUID()}`;
  const profile = getContainerRunProfile("qemu");
  const lease = tryAcquireExecutionAdmission({ profiles: [profile], interactive: true });
  if (!lease) throw new Error("Execution resources are temporarily busy; retry the QEMU display session.");
  const child = spawn("docker", dockerArgs(containerName, workspacePath, command), {
    shell: false,
    stdio: ["pipe", "pipe", "pipe"],
  });
  const session = {} as ActiveGraphicalQemuSession;
  Object.assign(session, {
    sessionId: args.sessionId,
    containerName,
    workspacePath,
    child,
    status: "running",
    output: "",
    exitCode: null,
    startedAt: new Date(),
    finishedAt: null,
    previousFrame: null,
    lease,
    limitReason: null,
    timer: setTimeout(() => {
      if (session.status !== "running") return;
      session.status = "timeout";
      appendOutput(session, "\n[QEMU display session reached its time limit]\n");
      forceRemoveContainer(containerName);
      child.kill("SIGKILL");
    }, Math.max(10, Math.min(args.timeoutSeconds ?? 180, 600)) * 1000),
  });
  sessions.set(args.sessionId, session);
  registerManagedContainer({
    containerName,
    profile,
    metadata: { sessionId: args.sessionId, workspacePath },
    onLimit: (reason) => {
      session.limitReason = reason;
      session.status = reason === "idle_timeout" ? "idle_timeout" : "resource_limit_exceeded";
      appendOutput(session, `\n${resourceLimitMessage(reason)}\n`);
      forceRemoveContainer(containerName);
      child.kill("SIGKILL");
    },
  });

  child.stdout.on("data", (chunk) => appendOutput(session, chunk));
  child.stderr.on("data", (chunk) => appendOutput(session, chunk));
  child.on("error", (error) => {
    appendOutput(session, `\n[runner error] ${error.message}\n`);
    session.status = "error";
    session.finishedAt = new Date();
    clearTimeout(session.timer);
    unregisterManagedContainer(containerName);
    session.lease.release();
  });
  child.on("close", (exitCode, signal) => {
    session.exitCode = exitCode;
    session.finishedAt = new Date();
    clearTimeout(session.timer);
    unregisterManagedContainer(containerName);
    session.lease.release();
    if (session.limitReason) return;
    if (session.status === "timeout" || session.status === "error") return;
    if (signal === "SIGKILL") session.status = "stopped";
    else session.status = exitCode === 0 ? "stopped" : "failed";
  });
  return snapshot(session);
}

function readPpm(buffer: Buffer) {
  let offset = 0;
  const token = () => {
    while (offset < buffer.length) {
      if (buffer[offset] === 35) {
        while (offset < buffer.length && buffer[offset] !== 10) offset += 1;
      } else if (buffer[offset] !== undefined && buffer[offset]! <= 32) offset += 1;
      else break;
    }
    const start = offset;
    while (offset < buffer.length && buffer[offset] !== undefined && buffer[offset]! > 32) offset += 1;
    return buffer.subarray(start, offset).toString("ascii");
  };
  if (token() !== "P6") throw new Error("QEMU returned an unsupported framebuffer format.");
  const width = Number(token());
  const height = Number(token());
  const maxValue = Number(token());
  if (buffer[offset] === 13 && buffer[offset + 1] === 10) offset += 2;
  else if (buffer[offset] !== undefined && buffer[offset]! <= 32) offset += 1;
  else throw new Error("QEMU returned an invalid framebuffer header separator.");
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0 || maxValue !== 255) {
    throw new Error("QEMU returned an invalid framebuffer header.");
  }
  if (width * height > MAX_FRAME_PIXELS) {
    throw new Error("QEMU framebuffer exceeds the Courseworks capture size limit.");
  }
  const pixels = buffer.subarray(offset);
  if (pixels.length !== width * height * 3) throw new Error("QEMU returned an incomplete framebuffer.");
  return { width, height, pixels };
}

const crcTable = Array.from({ length: 256 }, (_, value) => {
  let current = value;
  for (let bit = 0; bit < 8; bit += 1) current = (current & 1) ? 0xedb88320 ^ (current >>> 1) : current >>> 1;
  return current >>> 0;
});

function pngChunk(type: string, data: Buffer) {
  const typeBytes = Buffer.from(type, "ascii");
  const payload = Buffer.concat([typeBytes, data]);
  let crc = 0xffffffff;
  for (const byte of payload) crc = crcTable[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  const chunk = Buffer.alloc(12 + data.length);
  chunk.writeUInt32BE(data.length, 0);
  typeBytes.copy(chunk, 4);
  data.copy(chunk, 8);
  chunk.writeUInt32BE((crc ^ 0xffffffff) >>> 0, 8 + data.length);
  return chunk;
}

function encodePng(width: number, height: number, pixels: Buffer) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 2;
  const stride = width * 3;
  const rows = Buffer.alloc((stride + 1) * height);
  for (let row = 0; row < height; row += 1) pixels.copy(rows, row * (stride + 1) + 1, row * stride, (row + 1) * stride);
  return Buffer.concat([
    Buffer.from("89504e470d0a1a0a", "hex"),
    pngChunk("IHDR", header),
    pngChunk("IDAT", deflateSync(rows)),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

function analyzeFrame(width: number, height: number, pixels: Buffer, previous: Buffer | null) {
  const colors = new Set<number>();
  let brightness = 0;
  let darkPixels = 0;
  let changedPixels = 0;
  const pixelCount = width * height;
  const sampleStep = Math.max(1, Math.floor(pixelCount / 100_000));
  let sampled = 0;
  for (let pixel = 0; pixel < pixelCount; pixel += sampleStep) {
    const index = pixel * 3;
    const red = pixels[index]!;
    const green = pixels[index + 1]!;
    const blue = pixels[index + 2]!;
    const luma = (red * 299 + green * 587 + blue * 114) / 1000;
    brightness += luma;
    if (luma < 16) darkPixels += 1;
    colors.add((red << 16) | (green << 8) | blue);
    if (previous && previous.length === pixels.length
      && (previous[index] !== red || previous[index + 1] !== green || previous[index + 2] !== blue)) changedPixels += 1;
    sampled += 1;
  }
  const ramp = " .:-=+*#%@";
  const columns = Math.min(64, width);
  const rows = Math.min(24, Math.max(1, Math.round((height / width) * columns * 0.5)));
  const preview: string[] = [];
  for (let row = 0; row < rows; row += 1) {
    let line = "";
    for (let column = 0; column < columns; column += 1) {
      const x = Math.min(width - 1, Math.floor((column + 0.5) * width / columns));
      const y = Math.min(height - 1, Math.floor((row + 0.5) * height / rows));
      const index = (y * width + x) * 3;
      const luma = (pixels[index]! * 299 + pixels[index + 1]! * 587 + pixels[index + 2]! * 114) / 1000;
      line += ramp[Math.min(ramp.length - 1, Math.floor(luma * ramp.length / 256))];
    }
    preview.push(line.trimEnd());
  }
  return {
    meanBrightness: Number((brightness / sampled).toFixed(2)),
    darkPixelRatio: Number((darkPixels / sampled).toFixed(4)),
    uniqueColorEstimate: colors.size,
    uniformFrame: colors.size === 1,
    changedPixelRatio: previous && previous.length === pixels.length
      ? Number((changedPixels / sampled).toFixed(4))
      : null,
    asciiPreview: preview.join("\n"),
  };
}

export async function captureGraphicalQemuDisplay(sessionId: string): Promise<QemuDisplayCapture> {
  const session = sessions.get(sessionId);
  if (!session || session.status !== "running") throw new Error("QEMU display session is not running.");
  if (!(await isQmpReady(session))) {
    throw new Error("QMP is not ready. The command may still be building, may not have started QEMU, or may bypass the Courseworks QEMU wrapper.");
  }
  await qmpCommand(session, { execute: "screendump", arguments: { filename: QMP_CAPTURE } });
  let captureReady = false;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const checked = await runProcess("docker", [
      "exec", "--user", "1000:1000", session.containerName,
      "test", "-s", QMP_CAPTURE,
    ]).catch(() => null);
    if (checked?.exitCode === 0) {
      captureReady = true;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  if (!captureReady) {
    throw new Error("QEMU accepted the framebuffer capture command but did not produce an image file.");
  }
  const encoded = await runProcess("docker", [
    "exec", "--user", "1000:1000", session.containerName,
    "base64", "-w", "0", QMP_CAPTURE,
  ]);
  if (encoded.exitCode !== 0) {
    throw new Error(encoded.stderr.trim() || "Unable to read QEMU framebuffer.");
  }
  const ppm = Buffer.from(encoded.stdout.trim(), "base64");
  try {
    const { width, height, pixels } = readPpm(ppm);
    const analysis = analyzeFrame(width, height, pixels, session.previousFrame);
    session.previousFrame = Buffer.from(pixels);
    const png = encodePng(width, height, pixels);
    const captureDirectory = path.join(courseworksStateRoot(session.workspacePath), CAPTURE_ROOT, sessionId);
    await fs.mkdir(captureDirectory, { recursive: true, mode: 0o700 });
    const storedPath = path.join(captureDirectory, `${Date.now()}.png`);
    await fs.writeFile(storedPath, png, { mode: 0o600 });
    const captures = (await fs.readdir(captureDirectory))
      .filter((name) => name.endsWith(".png"))
      .sort();
    for (const expired of captures.slice(0, -MAX_CAPTURES_PER_SESSION)) {
      await fs.rm(path.join(captureDirectory, expired), { force: true });
    }
    return {
      width,
      height,
      frameHash: createHash("sha256").update(pixels).digest("hex"),
      ...analysis,
      storedPath,
      pngBase64: png.toString("base64"),
    };
  } finally {
    await runProcess("docker", [
      "exec", "--user", "1000:1000", session.containerName,
      "rm", "-f", QMP_CAPTURE,
    ]).catch(() => undefined);
  }
}

export function sendGraphicalQemuInput(sessionId: string, input: string) {
  const session = sessions.get(sessionId);
  if (!session || session.status !== "running") throw new Error("QEMU display session is not running.");
  session.child.stdin?.write(input);
  return snapshot(session);
}

export async function sendGraphicalQemuKeys(sessionId: string, keys: string) {
  const session = sessions.get(sessionId);
  if (!session || session.status !== "running") throw new Error("QEMU display session is not running.");
  if (!/^[A-Za-z0-9_-]+(?:-[A-Za-z0-9_-]+)*$/.test(keys) || keys.length > 80) {
    throw new Error("QEMU key sequence is invalid.");
  }
  await qmpCommand(session, {
    execute: "human-monitor-command",
    arguments: { "command-line": `sendkey ${keys}` },
  });
}

export function stopGraphicalQemuSession(sessionId: string) {
  const session = sessions.get(sessionId);
  if (!session) return null;
  if (session.status === "running") {
    appendOutput(session, "\n[QEMU display session stop requested]\n");
    session.status = "stopped";
    session.finishedAt = new Date();
    forceRemoveContainer(session.containerName);
    session.child.stdin?.end();
    session.child.kill("SIGKILL");
  }
  clearTimeout(session.timer);
  const result = snapshot(session);
  sessions.delete(sessionId);
  return result;
}

export function getGraphicalQemuSession(sessionId: string) {
  const session = sessions.get(sessionId);
  return session ? snapshot(session) : null;
}

export const graphicalQemuTestSupport = { readPpm, encodePng, analyzeFrame };
