#!/usr/bin/env node
/**
 * dsh-re-workbench — IDA MCP stdio proxy (zero dependency).
 *
 * 两种后端模式，按优先级自动选择：
 *
 *   1) idalib（无头，推荐）
 *      python idalib_stdio.py <target> [--unsafe]
 *      不需要 IDA GUI，不开窗口，不用手动点菜单。需要指定分析目标文件。
 *
 *   2) GUI 插件（回退）
 *      python ida_pro_mcp/server.py --transport stdio --ida-rpc <rpc>
 *      需要 IDA 开着并加载了数据库，插件自动监听 13337。
 *
 * 环境变量：
 *   RE_TARGET      — 分析目标（.exe/.dll/.so/.i64 等）。设了就优先走 idalib。
 *   RE_PYTHON      — python 可执行文件（默认从 PATH 探测）
 *   RE_IDA_RPC     — GUI 模式下的 IDA 插件 RPC（默认 http://127.0.0.1:13337）
 *   RE_UNSAFE      — 传 --unsafe（"1" 启用）
 *   RE_MODE        — 强制模式: "idalib" | "gui"
 */
import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const IDA_PRO_MCP = "ida_pro_mcp";
const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * 定位 python 解释器：RE_PYTHON > PATH > 常见安装位置。
 * 换机器/换 Python 版本无需改代码。
 */
function detectPython() {
  const fromEnv = (process.env.RE_PYTHON || "").trim();
  if (fromEnv && fs.existsSync(fromEnv)) return fromEnv;
  const names = process.platform === "win32" ? ["python.exe", "python3.exe"] : ["python3", "python"];
  for (const name of names) {
    try {
      const finder = process.platform === "win32" ? "where" : "which";
      const out = execFileSync(finder, [name], { encoding: "utf8", timeout: 5000, windowsHide: true });
      const first = out.split(/\r?\n/u).map((s) => s.trim()).filter(Boolean)[0];
      if (first && fs.existsSync(first)) return first;
    } catch { /* 继续找 */ }
  }
  const guesses = [];
  if (process.platform === "win32") {
    const local = process.env.LOCALAPPDATA || "";
    for (const v of ["313", "312", "311", "310"]) {
      guesses.push(path.join(local, "Programs", "Python", `Python${v}`, "python.exe"));
      guesses.push(`C:\\Python${v}\\python.exe`);
    }
    guesses.push(path.join(os.homedir(), "anaconda3", "python.exe"));
    guesses.push(path.join(os.homedir(), "miniconda3", "python.exe"));
  } else {
    guesses.push("/usr/bin/python3", "/usr/local/bin/python3", "/opt/homebrew/bin/python3");
  }
  return guesses.find((p) => p && fs.existsSync(p)) || "";
}

function sitePackages(python) {
  if (!fs.existsSync(python)) return null;
  const base = path.dirname(path.dirname(python));
  const cand = [
    path.join(path.dirname(python), "Lib", "site-packages"),
    path.join(base, "Lib", "site-packages"),
    path.join(base, "lib", "python3.14", "site-packages"),
    path.join(base, "lib", "python3.13", "site-packages"),
    path.join(base, "lib", "python3.12", "site-packages"),
    path.join(base, "lib", "python3.11", "site-packages"),
  ];
  return cand.find((p) => fs.existsSync(p)) || null;
}

/**
 * 解析分析目标：优先环境变量 RE_TARGET，其次 RE_TARGET_FILE 指向的文件内容。
 * 用文件是为了支持运行中切换——re_open 写文件后重启本进程即可换目标，
 * 无需重写 DSH 的插件配置。
 */
function resolveTarget() {
  const direct = (process.env.RE_TARGET || "").trim();
  if (direct) return direct;
  const file = (process.env.RE_TARGET_FILE || "").trim();
  if (!file) return "";
  try {
    const txt = fs.readFileSync(file, "utf8").trim();
    return txt || "";
  } catch {
    return "";
  }
}

function detect() {
  const python = detectPython();
  const sp = sitePackages(python);
  const serverPy = sp && fs.existsSync(path.join(sp, IDA_PRO_MCP, "server.py"))
    ? path.join(sp, IDA_PRO_MCP, "server.py")
    : null;

  // idalib 模式：优先用插件自带的 idalib_stdio.py，其次退回包内模块
  const localIdalib = path.join(__dirname, "idalib_stdio.py");
  const target = resolveTarget();
  const forceMode = (process.env.RE_MODE || "").toLowerCase();

  let mode = "gui";
  if (forceMode === "idalib") mode = "idalib";
  else if (forceMode === "gui") mode = "gui";
  else if (target && fs.existsSync(target) && fs.existsSync(localIdalib)) mode = "idalib";

  return { python, serverPy, sp, localIdalib, target, mode };
}

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + "\n");
}

function sendResult(id, result) {
  send({ jsonrpc: "2.0", id, result });
}

function sendError(id, message) {
  send({ jsonrpc: "2.0", id, error: { code: -32603, message } });
}

const env = detect();

function forward(child) {
  process.stdin.pipe(child.stdin);
  child.stdout.pipe(process.stdout);
  child.on("exit", (code) => process.exit(code || 0));
  child.on("error", (err) => {
    process.stderr.write(`[dsh-re-workbench] spawn error: ${err.message}\n`);
    process.exit(1);
  });
}

if (env.mode === "idalib") {
  // --- 无头模式：idalib 直接分析目标，无需 IDA GUI ---
  const args = [env.localIdalib, env.target];
  if (process.env.RE_UNSAFE === "1") args.push("--unsafe");
  process.stderr.write(
    `[dsh-re-workbench] idalib mode: ${env.target}\n` +
    `[dsh-re-workbench] python: ${env.python}\n`
  );
  const child = spawn(env.python, args, {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, PYTHONIOENCODING: "utf-8" },
    windowsHide: true,
  });
  child.stderr.on("data", (d) => process.stderr.write(d));
  forward(child);
} else if (!fs.existsSync(env.python) || !env.serverPy) {
  const problem = !fs.existsSync(env.python)
    ? `python 不存在: ${env.python}`
    : `未找到 ida_pro_mcp（期望位于 site-packages\\ida_pro_mcp\\server.py）`;
  const readline = await import("node:readline");
  const rl = readline.createInterface({ input: process.stdin, terminal: false });
  rl.on("line", (line) => {
    let msg;
    try { msg = JSON.parse(line); } catch { return; }
    if (msg.method === "initialize") {
      sendResult(msg.id, {
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "dsh-re-workbench-ida", version: "0.1.0" },
      });
      return;
    }
    if (msg.method === "notifications/initialized" || msg.method === "ping") return;
    if (msg.method === "tools/list") {
      sendResult(msg.id, {
        tools: [
          {
            name: "re_check",
            description: `逆向环境自检。当前问题：${problem}。修复：安装 Python 或 pip install ida_pro_mcp，或设置 RE_PYTHON 环境变量指向正确的 python.exe。`,
            inputSchema: { type: "object", properties: {} },
          },
        ],
      });
      return;
    }
    if (msg.method === "tools/call") {
      sendResult(msg.id, {
        content: [{ type: "text", text: `环境未就绪：${problem}` }],
        isError: true,
      });
      return;
    }
  });
  process.stdin.resume();
  process.exitCode = 0;
} else {
  // --- GUI 模式回退：连 IDA 插件的 RPC（需要 IDA 已开且加载了数据库）---
  const args = [env.serverPy, "--transport", "stdio"];
  if (process.env.RE_IDA_RPC) args.push("--ida-rpc", process.env.RE_IDA_RPC);
  if (process.env.RE_UNSAFE === "1") args.push("--unsafe");
  process.stderr.write(
    `[dsh-re-workbench] gui mode (ida-pro-mcp -> ${process.env.RE_IDA_RPC || "http://127.0.0.1:13337"})\n` +
    `[dsh-re-workbench] 提示：设 RE_TARGET=<目标文件> 可切换到无需 IDA GUI 的 idalib 模式\n`
  );
  const child = spawn(env.python, args, {
    stdio: ["pipe", "pipe", "inherit"],
    env: { ...process.env, PYTHONIOENCODING: "utf-8" },
    windowsHide: true,
  });
  forward(child);
}
