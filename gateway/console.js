/**
 * ComfyUI 无限画布 - 统一控制台
 *
 * 一个窗口管理 ComfyUI(8188) / 网关(8190) / 画布(3000)：
 * - 所有服务作为无窗口后台子进程运行，日志汇聚到本窗口
 * - 快捷键切换日志、重启、停止、打开浏览器
 * - 关闭窗口或按 Q 会一并停止所有服务
 *
 * 零第三方依赖，Node 22 直接运行。
 */
import { spawn, spawnSync } from "node:child_process";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import readline from "node:readline";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const NODE = path.join(ROOT, "node", "node.exe");
const COMFY_HOME = process.env.COMFY_HOME || "D:\\ComfyUI-Easy\\ComfyUI_windows_portable";
const COMFY_DIR = process.env.COMFY_DIR || path.join(COMFY_HOME, "ComfyUI");
const CANVAS_PORT = Number(process.env.CANVAS_PORT || 3000);
const NO_BROWSER = process.argv.includes("--no-browser");

let VERSION = "";
try {
  VERSION = fs.readFileSync(path.join(ROOT, "VERSION"), "utf8").trim();
} catch {
  VERSION = "";
}

const SERVICES = {
  comfy: {
    name: "ComfyUI",
    short: "Comfy",
    port: 8188,
    health: "/system_stats",
    cmd: path.join(COMFY_HOME, "python_embeded", "python.exe"),
    args: [
      "-s",
      path.join(COMFY_DIR, "main.py"),
      "--windows-standalone-build",
      "--port",
      "8188",
      "--listen",
      "127.0.0.1",
      "--lowvram",
    ],
    cwd: COMFY_HOME,
    env: {},
    waitMs: 120000,
  },
  gateway: {
    name: "网关",
    short: "网关",
    port: 8190,
    health: "/health",
    cmd: NODE,
    args: [path.join(ROOT, "gateway", "server.js")],
    cwd: ROOT,
    env: { COMFY_DIR },
    waitMs: 15000,
  },
  canvas: {
    name: "画布",
    short: "画布",
    port: CANVAS_PORT,
    health: "/",
    cmd: NODE,
    args: [path.join(ROOT, "gateway", "serve-canvas.js")],
    cwd: ROOT,
    env: {},
    waitMs: 15000,
  },
};

const IDS = Object.keys(SERVICES);
const state = {};
const history = {};
const partial = {};
for (const id of IDS) {
  state[id] = { status: "idle", child: null, external: false, pid: null, since: 0 };
  history[id] = [];
  partial[id] = { out: "", err: "" };
}

const MAX_HISTORY = 400;
let view = "all";
let shuttingDown = false;

const C = {
  reset: "\x1b[0m",
  dim: "\x1b[90m",
  title: "\x1b[1m",
  ok: "\x1b[92m",
  warn: "\x1b[93m",
  err: "\x1b[91m",
  comfy: "\x1b[96m",
  gateway: "\x1b[93m",
  canvas: "\x1b[92m",
};

function write(text) {
  try {
    process.stdout.write(text);
  } catch {
    /* 管道已关闭 */
  }
}

function now() {
  return new Date().toLocaleTimeString("zh-CN", { hour12: false });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function formatUptime(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m${String(s % 60).padStart(2, "0")}s`;
  return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, "0")}m`;
}

function formatLog(id, level, text, time) {
  const color = level === "err" ? C.err : C[id];
  return `${C.dim}[${time}]${C.reset} ${color}[${SERVICES[id].short}]${C.reset} ${text}\n`;
}

function logLine(id, level, text) {
  const clean = text.replace(/\x1b\[[0-9;]*m/g, "").trimEnd();
  if (!clean) return;
  // 用户只看画布地址：屏蔽 8188 / 8190 的 URL 提示行
  if (/https?:\/\/127\.0\.0\.1:(8188|8190)\b/.test(clean)) return;
  const time = now();
  history[id].push({ level, text: clean, time });
  if (history[id].length > MAX_HISTORY) {
    history[id].splice(0, history[id].length - MAX_HISTORY);
  }
  if (view === "all" || view === id) {
    write(formatLog(id, level, clean, time));
  }
}

function feed(id, level, chunk) {
  partial[id][level] += chunk.toString("utf8");
  const lines = partial[id][level].split(/\r?\n/);
  partial[id][level] = lines.pop() || "";
  for (const line of lines) logLine(id, level, line);
}

function flush(id) {
  for (const level of ["out", "err"]) {
    const rest = partial[id][level];
    if (rest) logLine(id, level, rest);
    partial[id][level] = "";
  }
}

function probe(port, pathname, timeout = 700) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (value) => {
      if (!done) {
        done = true;
        resolve(value);
      }
    };
    const req = http.get({ host: "127.0.0.1", port, path: pathname, timeout }, (res) => {
      res.resume();
      finish(true);
    });
    req.on("timeout", () => {
      req.destroy();
      finish(false);
    });
    req.on("error", () => finish(false));
  });
}

function statusIcon(id) {
  const s = state[id].status;
  if (s === "running") return `${C.ok}● 运行中${C.reset}`;
  if (s === "starting") return `${C.warn}◐ 启动中${C.reset}`;
  if (s === "external") return `${C.ok}◆ 外部已运行${C.reset}`;
  if (s === "failed") return `${C.err}✖ 异常退出${C.reset}`;
  if (s === "stopped") return `${C.dim}○ 已停止${C.reset}`;
  return `${C.dim}○ 未启动${C.reset}`;
}

function printStatus() {
  const parts = IDS.map((id) => {
    const svc = SERVICES[id];
    const st = state[id];
    let detail = "";
    if (st.pid && st.status !== "external") detail += ` pid=${st.pid}`;
    if (st.since && (st.status === "running" || st.status === "starting")) {
      detail += ` ${formatUptime(Date.now() - st.since)}`;
    }
    return `${svc.name} ${statusIcon(id)}${C.dim}${detail}${C.reset}`;
  });
  write(`\n${C.title}[状态]${C.reset} ${parts.join(` ${C.dim}|${C.reset} `)}\n`);
}

function printBanner() {
  write(`\n${C.title}============================================================${C.reset}\n`);
  write(`${C.title}  ComfyUI 无限画布 · 统一控制台${C.reset}  ${C.dim}${VERSION}${C.reset}\n`);
  write(`${C.title}============================================================${C.reset}\n`);
  write(`${C.dim}  三个服务在同一个窗口运行；按 Q 退出会一并停止服务${C.reset}\n`);
}

function printHelp() {
  write(
    `\n${C.title}快捷键${C.reset}: ` +
      `${C.dim}0/A${C.reset}全部日志  ${C.dim}1/2/3${C.reset}Comfy/网关/画布  ` +
      `${C.dim}R${C.reset}重启  ${C.dim}S${C.reset}停止  ` +
      `${C.dim}B${C.reset}浏览器  ${C.dim}H${C.reset}帮助  ${C.dim}Q${C.reset}退出\n`,
  );
}

function renderHistory(id) {
  const rows = history[id].slice(-25);
  for (const row of rows) write(formatLog(id, row.level, row.text, row.time));
}

function openBrowser() {
  try {
    spawn("cmd", ["/c", "start", "", `http://127.0.0.1:${CANVAS_PORT}`], {
      windowsHide: true,
      detached: true,
      stdio: "ignore",
    }).unref();
  } catch (err) {
    write(`${C.err}打开浏览器失败: ${err.message}${C.reset}\n`);
  }
}

async function startService(id) {
  if (shuttingDown) return;
  const svc = SERVICES[id];
  const st = state[id];

  if (await probe(svc.port, svc.health, 500)) {
    st.status = "external";
    st.external = true;
    st.child = null;
    st.pid = null;
    write(`${C.dim}  ↳ ${svc.name} 已在运行，直接复用${C.reset}\n`);
    return;
  }

  st.external = false;
  st.status = "starting";
  st.since = Date.now();

  let child;
  try {
    child = spawn(svc.cmd, svc.args, {
      cwd: svc.cwd,
      env: { ...process.env, ...svc.env },
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (err) {
    st.status = "failed";
    logLine(id, "err", `进程启动失败: ${err.message}`);
    return;
  }

  st.child = child;
  st.pid = child.pid || null;
  child.stdout.on("data", (buf) => feed(id, "out", buf));
  child.stderr.on("data", (buf) => feed(id, "err", buf));
  child.on("error", (err) => {
    logLine(id, "err", `进程错误: ${err.message}`);
    if (state[id].child === child) state[id].status = "failed";
  });
  child.on("exit", (code, signal) => {
    flush(id);
    if (state[id].child !== child) return;
    state[id].child = null;
    if (!shuttingDown && state[id].status !== "stopped") {
      state[id].status = "failed";
      logLine(id, "err", `进程退出 (code=${code}, signal=${signal || "-"})，按 R 重启`);
      printStatus();
    }
  });
}

async function waitReady(id, maxMs) {
  const svc = SERVICES[id];
  const start = Date.now();
  while (Date.now() - start < maxMs) {
    if (shuttingDown || state[id].external) return false;
    if (state[id].status === "failed" || state[id].status === "stopped") return false;
    if (await probe(svc.port, svc.health, 400)) return true;
    await sleep(500);
  }
  return false;
}

async function waitAll(ids) {
  await Promise.all(
    ids.map(async (id) => {
      if (state[id].external) return;
      const ok = await waitReady(id, SERVICES[id].waitMs);
      if (ok) {
        state[id].status = "running";
        state[id].since = Date.now();
        logLine(id, "out", id === "comfy" ? "启动成功" : "已就绪");
      } else if (state[id].status === "starting") {
        state[id].status = "failed";
        logLine(id, "err", `等待端口 ${SERVICES[id].port} 就绪超时，请检查上方日志`);
      }
      printStatus();
    }),
  );
}

function stopService(id, quiet = false) {
  const st = state[id];
  if (st.external || !st.child) {
    if (!st.external) st.status = "stopped";
    return;
  }
  const pid = st.child.pid;
  st.status = "stopped";
  st.child = null;
  st.since = 0;
  if (pid) {
    const result = spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], {
      windowsHide: true,
      stdio: "ignore",
    });
    if (result.error && !quiet) logLine(id, "err", `停止失败: ${result.error.message}`);
  }
  logLine(id, "out", "已停止");
}

async function restart(ids) {
  if (shuttingDown) return;
  for (const id of ids) stopService(id);
  printStatus();
  await sleep(700);
  for (const id of ids) await startService(id);
  await waitAll(ids);
  write(`\n${C.ok}重启完成${C.reset}\n`);
}

function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  write(`\n${C.warn}正在停止所有服务...${C.reset}\n`);
  for (const id of IDS) stopService(id, true);
  setTimeout(() => process.exit(0), 300);
}

function handleInput(str, key) {
  if (key && key.ctrl && (key.name === "c" || key.name === "d")) {
    shutdown();
    return;
  }
  const ch = String(str || "").toLowerCase();
  if (!ch) return;

  if (ch === "q") return shutdown();
  if (ch === "h") return printHelp();
  if (ch === "b") return openBrowser();

  if (ch === "0" || ch === "a") {
    view = "all";
    write(`\n${C.dim}--- 显示全部日志 ---${C.reset}\n`);
    return;
  }
  if (["1", "2", "3"].includes(ch)) {
    view = IDS[Number(ch) - 1];
    write(`\n${C.dim}--- 只看 ${SERVICES[view].name} 日志 ---${C.reset}\n`);
    renderHistory(view);
    return;
  }
  if (ch === "r") {
    const ids = view === "all" ? IDS : [view];
    write(`\n${C.warn}重启: ${ids.map((id) => SERVICES[id].name).join(" / ")}${C.reset}\n`);
    restart(ids);
    return;
  }
  if (ch === "s") {
    const ids = view === "all" ? IDS : [view];
    for (const id of ids) stopService(id);
    printStatus();
  }
}

process.on("exit", () => {
  for (const id of IDS) stopService(id, true);
});
process.on("SIGINT", shutdown);
process.on("SIGBREAK", shutdown);

readline.emitKeypressEvents(process.stdin);
if (process.stdin.isTTY) {
  try {
    process.stdin.setRawMode(true);
  } catch {
    /* 部分终端不支持 raw mode */
  }
}
process.stdin.resume();
process.stdin.on("keypress", handleInput);

printBanner();
printHelp();
write(`\n${C.dim}正在检查并启动服务...${C.reset}\n`);

for (const id of IDS) await startService(id);
printStatus();
await waitAll(IDS);

const failed = IDS.filter((id) => state[id].status === "failed");
if (failed.length === 0) {
  write(`\n${C.ok}${C.title}全部就绪！ComfyUI 启动成功${C.reset}\n`);
} else {
  write(`\n${C.err}以下服务启动失败: ${failed.map((id) => SERVICES[id].name).join(" / ")}${C.reset}\n`);
}
write(`\n  ${C.dim}画布地址${C.reset} ${C.ok}http://127.0.0.1:${CANVAS_PORT}/${C.reset}\n\n`);

if (!NO_BROWSER) openBrowser();
