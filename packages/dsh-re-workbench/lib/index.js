import { defineTool } from "@deepseek-ai/dsh-tools";
import z from "@deepseek-ai/schemastery";
import fs from "node:fs";
import os from "node:os";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { createConnection } from "node:net";

export const name = "re-workbench";
export const inject = ["tools", "systemPrompt"];

export const Config = z.object({
  pythonPath: z.string(),
  idaRpc: z.string(),
  unsafe: z.boolean(),
  // idalib 模式的默认分析目标；设了就无需打开 IDA GUI
  target: z.string(),
});

let cachedPython;

/**
 * 定位 python 解释器：环境变量 RE_PYTHON > PATH 里的 python/python3 > 常见安装位置。
 * 不再写死某一台机器的路径，换机器/换 Python 版本都能用。
 */
export function detectPython(configured) {
  if (configured && fs.existsSync(configured)) return configured;
  if (cachedPython) return cachedPython;
  const fromEnv = process.env.RE_PYTHON;
  if (fromEnv && fs.existsSync(fromEnv)) return (cachedPython = fromEnv);
  const names = process.platform === "win32" ? ["python.exe", "python3.exe"] : ["python3", "python"];
  try {
    const finder = process.platform === "win32" ? "where" : "which";
    const out = execFileSync(finder, [names[0]], { encoding: "utf8", timeout: 5000, windowsHide: true });
    const first = out.split(/\r?\n/u).map((s) => s.trim()).filter(Boolean)[0];
    if (first && fs.existsSync(first)) return (cachedPython = first);
  } catch { /* 继续找 */ }
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
  const hit = guesses.find((p) => p && fs.existsSync(p));
  if (hit) cachedPython = hit;
  return hit || null;
}

function resolvePython(cfg) {
  return detectPython(cfg?.pythonPath) || cfg?.pythonPath || "python";
}

const OUTPUT = {
  schema: { type: "object", additionalProperties: true },
  render: (_args, value) => [{ type: "text", text: JSON.stringify(value, null, 2) }],
};

function present(title, kind, rawInput) {
  return { title, kind, subtitle: rawInput, pending: "检查中…" };
}

const GUIDE = `# 逆向分析工作台（re-workbench）
配合 IDA MCP 工具完成二进制逆向，两种模式：

**idalib 无头模式（默认，推荐）**：设 RE_TARGET 或先调 re_open 指定目标文件，
无需打开 IDA GUI，进程内加载分析，启动即用。
**GUI 模式（回退）**：不设目标时连接已运行的 IDA（插件监听 13337）。

工作流：
1. 调 re_check 看当前模式与就绪状态；
2. idalib 模式：re_open 指定目标文件 → 自动加载分析（大文件可能要等几十秒）；
   GUI 模式：确认目标已在 IDA Pro 中打开；
3. 分析套路：先看 PE/ELF 头与导入表 → 定位入口/关键函数 → 反编译 → 追踪 xref 调用链 → 重命名/打注释 → 总结行为；
4. 结果报告按「目标信息 → 关键函数 → 调用关系 → 结论」组织，附地址与函数名。

注意：idalib 模式下 re_open 会重启分析进程，切换目标后此前会话中的分析状态失效。`;

function findServerPy(python) {
  const base = path.dirname(path.dirname(python));
  const ida = "ida_pro_mcp\\server.py";
  const cand = [
    path.join(path.dirname(python), "Lib", "site-packages", ida),
    path.join(base, "Lib", "site-packages", ida),
  ];
  return cand.find((p) => fs.existsSync(p)) || null;
}

function probeIdaPort(host, port, timeoutMs) {
  return new Promise((resolve) => {
    const sock = createConnection({ host, port, timeout: timeoutMs || 800 });
    sock.once("connect", () => { sock.destroy(); resolve(true); });
    sock.once("error", () => resolve(false));
    sock.once("timeout", () => { sock.destroy(); resolve(false); });
  });
}

function parseRpc(url) {
  try {
    const u = new URL(url);
    return { host: u.hostname, port: Number(u.port || 80) };
  } catch {
    return { host: "127.0.0.1", port: 13337 };
  }
}

export function apply(ctx, config) {
  const cfg = config || {};

  ctx.systemPrompt.section({
    name: "tool:re-workbench",
    order: 131,
    text: GUIDE,
  });

  ctx.tools.register(defineTool({
    name: "re_check",
    description:
      "逆向环境自检：python、ida_pro_mcp 包、idalib 无头模式是否可用，以及 GUI 模式下 IDA RPC 端口（默认 127.0.0.1:13337）是否在线。做任何 IDA 操作前先调用。",
    parameters: {},
    output: OUTPUT,
    async execute() {
      const python = resolvePython(cfg);
      const serverPy = findServerPy(python);
      const rpc = parseRpc(cfg.idaRpc || "http://127.0.0.1:13337");
      const idaAlive = await probeIdaPort(rpc.host, rpc.port);
      const target = process.env.RE_TARGET || cfg.target || "";
      const targetExists = Boolean(target) && fs.existsSync(target);
      const idalibReady = fs.existsSync(python) && targetExists;
      const pythonOk = fs.existsSync(python);
      return {
        python,
        pythonExists: pythonOk,
        idaProMcp: serverPy || null,
        idaProMcpInstalled: Boolean(serverPy),
        mode: idalibReady ? "idalib" : "gui",
        idalib: {
          ready: idalibReady,
          target: target || null,
          targetExists,
          note: idalibReady
            ? "无头模式就绪：MCP 工具直接分析该目标，无需 IDA GUI"
            : "未设目标：调用 re_open 指定文件以启用无头模式",
        },
        gui: {
          idaRpc: `${rpc.host}:${rpc.port}`,
          idaPluginRunning: idaAlive,
          ready: pythonOk && Boolean(serverPy) && idaAlive,
        },
        ready: idalibReady || (pythonOk && Boolean(serverPy) && idaAlive),
        hint: idalibReady
          ? "idalib 无头模式就绪，可直接调用 IDA MCP 工具分析目标"
          : idaAlive
            ? "GUI 模式就绪（IDA 在线）"
            : "尚未就绪：用 re_open 指定目标文件（无头模式），或在 IDA 中启动 MCP 插件",
      };
    },
    presentCall: () => present("逆向环境自检", "read"),
  }));

  ctx.tools.register(defineTool({
    name: "re_open",
    description:
      "【无头模式】指定/切换要分析的二进制文件（.exe/.dll/.so/.sys/.i64 等）。设置后会重启分析进程并用 idalib 加载该目标，无需打开 IDA。大文件分析需要等待。",
    parameters: {
      file: {
        type: "string",
        required: true,
        description: "目标文件的绝对路径（.exe/.dll/.so/.sys/.i64 等）",
      },
      unsafe: {
        type: "boolean",
        description: "是否启用 ida-pro-mcp 的危险函数，默认关闭。",
      },
    },
    output: OUTPUT,
    async execute(args) {
      const file = String(args?.file || "").trim();
      if (!file) return { ok: false, error: "缺少 file 参数（目标文件绝对路径）" };
      const abs = path.resolve(file);
      if (!fs.existsSync(abs)) return { ok: false, error: `文件不存在: ${abs}`, file: abs };
      const stat = fs.statSync(abs);
      if (!stat.isFile()) return { ok: false, error: `不是文件: ${abs}` };

      const python = resolvePython(cfg);
      if (!fs.existsSync(python)) return { ok: false, error: `python 不可用: ${python}。请安装 Python 或设置 RE_PYTHON 环境变量指向 python.exe` };

      // 写入目标文件：mcp/server.js 启动时读取它决定分析对象。
      // 用文件而非进程环境，是为了让「重启 MCP server」就能换目标，
      // 不必重写 DSH 的插件配置。
      const targetFile = process.env.RE_TARGET_FILE || path.join(os.homedir(), ".dsh", "re-target.txt");
      try {
        fs.mkdirSync(path.dirname(targetFile), { recursive: true });
        fs.writeFileSync(targetFile, abs, "utf8");
      } catch (e) {
        return { ok: false, error: `写入目标文件失败: ${targetFile} (${e?.message || e})` };
      }

      // 同时写进程环境（若 MCP server 恰好继承此环境则立即生效）
      process.env.RE_TARGET = abs;
      if (args?.unsafe === true || cfg.unsafe === true) process.env.RE_UNSAFE = "1";
      else delete process.env.RE_UNSAFE;

      // 触发 MCP 重连：断开当前连接，DSH 会按 reconnect 策略重连，
      // 新进程启动时读取 targetFile 得到新目标。
      let reconnected = false;
      let reconnectNote = "";
      try {
        const clients = ctx.get?.("mcpClients") || ctx.get?.("mcp");
        if (clients && typeof clients.restart === "function") {
          await clients.restart("ida");
          reconnected = true;
          reconnectNote = "已请求 MCP server 重启（ida）";
        }
      } catch (e) {
        reconnectNote = `自动重连不可用：${e?.message || e}`;
      }

      return {
        ok: true,
        mode: "idalib",
        target: abs,
        targetFile,
        sizeBytes: stat.size,
        mtime: stat.mtime.toISOString(),
        reconnected,
        note: reconnected
          ? `${reconnectNote}。稍候即可用 mcp__ida__* 工具分析新目标（大文件首次分析需等待）。`
          : `目标已写入 ${targetFile}。${reconnectNote || ""}` +
            "如需立即生效，请重启 DSH（或在设置里重载插件），此后 mcp__ida__* 工具将分析该目标。",
      };
    },
    presentCall: (args) => present("设置分析目标", "write", String(args?.file || "")),
  }));

  ctx.tools.register(defineTool({
    name: "re_status",
    description: "查看当前分析目标与 MCP 桥状态（目标文件内容、目标是否可访问、MCP 环境变量是否就绪）。",
    parameters: {},
    output: OUTPUT,
    async execute() {
      const python = resolvePython(cfg);
      const targetFile = process.env.RE_TARGET_FILE || path.join(os.homedir(), ".dsh", "re-target.txt");
      let target = process.env.RE_TARGET || "";
      let fromFile = false;
      if (!target && fs.existsSync(targetFile)) {
        try {
          target = fs.readFileSync(targetFile, "utf8").trim();
          fromFile = Boolean(target);
        } catch { /* ignore */ }
      }
      return {
        mode: target && fs.existsSync(target) ? "idalib" : "gui",
        target: target || null,
        targetSource: fromFile ? "file" : target ? "env" : "none",
        targetFile,
        targetExists: Boolean(target) && fs.existsSync(target),
        pythonExists: fs.existsSync(python),
        toolsPrefix: "mcp__ida__",
      };
    },
    presentCall: () => present("查看分析状态", "read"),
  }));
}

