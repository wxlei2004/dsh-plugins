import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * 探测 SPSS 安装位置：环境变量 > 常见安装目录（多版本/多盘符）。
 * 不写死某一台机器的路径，换机器只需装 SPSS 或设置 SPSS_PATH。
 */
export function detectSpss() {
  const candidates = {
    stats: [
      process.env.SPSS_PATH,
      ...spssVersionDirs().map((d) => path.join(d, "stats.exe")),
      "C:\\Program Files\\SPSS\\stats.exe",
      "/Applications/IBM/SPSS/Statistics/26/SPSSStatistics.app/Contents/MacOS/stats",
      "/opt/ibm/SPSS/Statistics/26/stats",
    ].filter(Boolean),
    pythonBat: [
      process.env.SPSS_PYTHON_BAT,
      ...spssVersionDirs().map((d) => path.join(d, "statisticspython3.bat")),
      "/Applications/IBM/SPSS/Statistics/26/SPSSStatistics.app/Contents/MacOS/statisticspython3",
      "/opt/ibm/SPSS/Statistics/26/statisticspython3",
    ].filter(Boolean),
  };
  return {
    stats: candidates.stats.find((p) => fs.existsSync(p)) || null,
    pythonBat: candidates.pythonBat.find((p) => fs.existsSync(p)) || null,
  };
}

/** 枚举常见 SPSS 安装目录（版本 25-31，Program Files 与 Program Files (x86)）。 */
function spssVersionDirs() {
  const roots = ["C:\\Program Files\\IBM\\SPSS\\Statistics", "C:\\Program Files (x86)\\IBM\\SPSS\\Statistics"];
  const dirs = [];
  for (const root of roots) {
    for (const v of ["31", "30", "29", "28", "27", "26", "25"]) {
      dirs.push(path.join(root, v));
    }
  }
  return dirs;
}

export function defaultWorkDir() {
  return path.join(os.tmpdir(), "dsh-thesis-spss");
}

export function normalizeConfig(config = {}) {
  const workDir = config.workDir || defaultWorkDir();
  if (!fs.existsSync(workDir)) fs.mkdirSync(workDir, { recursive: true });
  const detected = detectSpss();
  return {
    stats: config.spssStats || detected.stats || null,
    pythonBat: config.spssPythonBat || detected.pythonBat || null,
    workDir,
  };
}

function runPython(pythonBat, scriptPath, timeoutSec) {
  const timeout = (timeoutSec || 180) * 1000;
  return new Promise((resolve, reject) => {
    const proc = spawn(`"${pythonBat}" "${scriptPath}"`, {
      timeout,
      maxBuffer: 32 * 1024 * 1024,
      env: { ...process.env, PYTHONIOENCODING: "utf-8" },
      shell: true,
      windowsHide: true,
    });
    const chunks = [];
    let stderr = "";
    proc.stdout.on("data", (d) => { chunks.push(Buffer.from(d)); });
    proc.stderr.on("data", (d) => { stderr += d.toString("utf8"); });
    proc.on("close", (code) => {
      if (code !== 0) {
        reject(new Error((stderr || `Process exited with code ${code}`).substring(0, 3000)));
      } else {
        resolve(Buffer.concat(chunks));
      }
    });
    proc.on("error", (err) => reject(new Error(`Spawn error: ${err.message}`)));
    proc.on("timeout", () => {
      proc.kill();
      reject(new Error(`SPSS Python timed out after ${timeoutSec}s`));
    });
  });
}

const MARK_START = "MCP_JSON_START";
const MARK_END = "MCP_JSON_END";

function decodeMixed(buf) {
  const ascii = buf.toString("latin1");
  let json = null;
  let rest = buf;
  const start = ascii.indexOf(MARK_START);
  if (start >= 0) {
    const end = ascii.indexOf(MARK_END, start);
    if (end > start) {
      json = buf.subarray(start + MARK_START.length, end).toString("utf8");
      rest = Buffer.concat([buf.subarray(0, start), buf.subarray(end + MARK_END.length)]);
    }
  }
  let text;
  try {
    text = rest.toString("gbk").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "");
  } catch {
    text = rest.toString("utf8");
  }
  return { json, text: text.trim() };
}

function writePyScript(workDir, content) {
  const id = `tw-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const pyPath = path.join(workDir, `${id}.py`);
  fs.writeFileSync(pyPath, content, { encoding: "utf8" });
  return pyPath;
}

export function extractJson(out) {
  const start = out.indexOf("MCP_JSON_START");
  const end = out.indexOf("MCP_JSON_END");
  if (start >= 0 && end > start) {
    return out.substring(start + "MCP_JSON_START".length, end);
  }
  const lines = out.trim().split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const l = lines[i].trim();
    if (l.startsWith("{") || l.startsWith("[")) {
      try { JSON.parse(l); return l; } catch {}
    }
  }
  return null;
}

const PY_HEADER = `# -*- coding: utf-8 -*-
import spss, json, sys, os

def emit(obj):
    print("MCP_JSON_START" + json.dumps(obj, ensure_ascii=False, indent=2) + "MCP_JSON_END")
`;

function safe(p) {
  return p ? p.replace(/\\/g, "/") : null;
}

function pyStr(v) {
  return v ? JSON.stringify(String(v).replace(/\\/g, "/")) : "None";
}

function pyRunSyntax(syntax, dataFile) {
  return `${PY_HEADER}
syntax = ${JSON.stringify(syntax)}
data_file = ${pyStr(dataFile)}
try:
    if data_file:
        spss.Submit("GET FILE='%s'." % data_file)
    spss.Submit(syntax)
    emit({"ok": True, "syntax_run": True})
except Exception as e:
    emit({"error": str(e)})
    sys.exit(1)
`;
}

function pyRunSyntaxFile(spsPath) {
  return `${PY_HEADER}
sps_path = ${pyStr(spsPath)}
sps_dir = os.path.dirname(sps_path)
try:
    import re
    with open(sps_path, "r", encoding="utf-8-sig") as f:
        syntax = f.read()
    syntax = syntax.lstrip("\\ufeff")
    syntax = re.sub(r"^CD\\s+'[^']*'\\s*\\.", "CD '%s'." % sps_dir, syntax, flags=re.MULTILINE)
    def abs_file(m):
        fname = m.group(1)
        if not os.path.isabs(fname):
            fname = sps_dir + "/" + fname
        return "GET FILE='%s'." % fname
    syntax = re.sub(r"GET\\s+FILE='([^']*)'\\.", abs_file, syntax)
    spss.Submit(syntax)
    emit({"ok": True, "syntax_file": sps_path})
except Exception as e:
    emit({"error": str(e)})
    sys.exit(1)
`;
}

function pyListVariables(savPath) {
  return `${PY_HEADER}
sav = ${pyStr(savPath)}
try:
    spss.Submit("GET FILE='%s'." % sav)
    n = spss.GetVariableCount()
    if n == 0:
        emit({"error": "No variables found"})
        sys.exit(0)
    vars_list = []
    for i in range(n):
        vars_list.append({
            "index": i,
            "name": spss.GetVariableName(i),
            "label": spss.GetVariableLabel(i) or "",
            "type": "numeric" if spss.GetVariableType(i) == 0 else "string",
            "width": spss.GetVariableType(i),
            "measure": spss.GetVariableMeasurementLevel(i),
        })
    emit({"variable_count": n, "case_count": spss.GetCaseCount(), "variables": vars_list})
except Exception as e:
    emit({"error": str(e)})
`;
}

function pyGetData(savPath, varNames, maxRows) {
  return `${PY_HEADER}
sav = ${pyStr(savPath)}
var_names = ${JSON.stringify(varNames || [])}
max_rows = ${Math.max(1, Number(maxRows) || 100)}
try:
    import math
    spss.Submit("GET FILE='%s'." % sav)
    all_vars = [spss.GetVariableName(i) for i in range(spss.GetVariableCount())]
    if not var_names:
        var_names = all_vars
    else:
        missing = [v for v in var_names if v not in all_vars]
        if missing:
            emit({"error": "Variables not found: %s" % str(missing)})
            sys.exit(0)
    var_indices = [all_vars.index(v) for v in var_names]
    rows = []
    cursor = spss.Cursor(var_indices)
    for i in range(min(max_rows, spss.GetCaseCount())):
        row = cursor.fetchone()
        if row is None:
            break
        def clean(v):
            if v is None:
                return None
            if isinstance(v, float) and (math.isnan(v) or math.isinf(v)):
                return None
            return v
        rows.append(dict(zip(var_names, [clean(v) for v in row])))
    cursor.close()
    emit({"case_count": spss.GetCaseCount(), "returned_rows": len(rows), "variables": var_names, "data": rows})
except Exception as e:
    emit({"error": str(e)})
`;
}

function pyAnalyze(syntax, dataFile) {
  return `${PY_HEADER}
syntax = ${JSON.stringify(syntax)}
data_file = ${pyStr(dataFile)}
try:
    if data_file is not None:
        spss.Submit("GET FILE='%s'." % data_file)
    spss.Submit(syntax)
    emit({"ok": True, "syntax_run": True})
except Exception as e:
    emit({"error": str(e)})
    sys.exit(1)
`;
}

export async function check(cfg) {
  const c = normalizeConfig(cfg);
  const out = {
    stats: null,
    pythonBat: null,
    statsExists: Boolean(c.stats) && fs.existsSync(c.stats),
    pythonBatExists: Boolean(c.pythonBat) && fs.existsSync(c.pythonBat),
    workDir: c.workDir,
    hint:
      "未探测到 SPSS。请安装 SPSS（25-31 任一版本），或在插件 config 里设置 spssStats / spssPythonBat，或设 SPSS_PATH / SPSS_PYTHON_BAT 环境变量。",
  };
  if (out.statsExists) out.stats = c.stats;
  if (out.pythonBatExists) out.pythonBat = c.pythonBat;
  out.ready = out.statsExists && out.pythonBatExists;
  return out;
}

/** 缺 SPSS 时给出可读错误，而不是 spawn 一个 undefined。 */
function assertReady(c) {
  if (!c.pythonBat) {
    throw new Error(
      "未找到 statisticspython3.bat。请安装 SPSS 或在插件 config 里设置 spssPythonBat（或设 SPSS_PYTHON_BAT 环境变量）。先跑 spss_check 查看探测结果。"
    );
  }
}

export async function runSyntax(cfg, { syntax, dataFile, timeout }) {
  const c = normalizeConfig(cfg);
  assertReady(c);
  const pyPath = writePyScript(c.workDir, pyRunSyntax(syntax, dataFile));
  try {
    const { json, text } = decodeMixed(await runPython(c.pythonBat, pyPath, timeout || 180));
    let status = "ok";
    if (json) {
      const data = JSON.parse(json);
      if (data.error) throw new Error(`SPSS error: ${data.error}`);
    }
    return { status, output: text || "(SPSS ran but produced no stdout output)" };
  } finally {
    try { fs.unlinkSync(pyPath); } catch {}
  }
}

export async function runSyntaxFile(cfg, { spsPath, timeout }) {
  if (!fs.existsSync(spsPath)) throw new Error(`File not found: ${spsPath}`);
  const c = normalizeConfig(cfg);
  assertReady(c);
  const pyPath = writePyScript(c.workDir, pyRunSyntaxFile(spsPath));
  try {
    const { json, text } = decodeMixed(await runPython(c.pythonBat, pyPath, timeout || 180));
    if (json) {
      const data = JSON.parse(json);
      if (data.error) throw new Error(`SPSS error: ${data.error}`);
    }
    return { status: "ok", output: text || "(SPSS ran but produced no stdout output)" };
  } finally {
    try { fs.unlinkSync(pyPath); } catch {}
  }
}

export async function listVariables(cfg, { savPath }) {
  if (!fs.existsSync(savPath)) throw new Error(`File not found: ${savPath}`);
  const c = normalizeConfig(cfg);
  assertReady(c);
  const pyPath = writePyScript(c.workDir, pyListVariables(savPath));
  try {
    const { json, text } = decodeMixed(await runPython(c.pythonBat, pyPath, 60));
    if (json) {
      const data = JSON.parse(json);
      if (data.error) throw new Error(`SPSS error: ${data.error}`);
      return data;
    }
    throw new Error(text || "No JSON output");
  } finally {
    try { fs.unlinkSync(pyPath); } catch {}
  }
}

export async function getData(cfg, { savPath, variables, maxRows }) {
  if (!fs.existsSync(savPath)) throw new Error(`File not found: ${savPath}`);
  const c = normalizeConfig(cfg);
  assertReady(c);
  const pyPath = writePyScript(c.workDir, pyGetData(savPath, variables || [], maxRows || 100));
  try {
    const { json, text } = decodeMixed(await runPython(c.pythonBat, pyPath, 120));
    if (json) {
      const data = JSON.parse(json);
      if (data.error) throw new Error(`SPSS error: ${data.error}`);
      return data;
    }
    throw new Error(text || "No JSON output");
  } finally {
    try { fs.unlinkSync(pyPath); } catch {}
  }
}

export async function analyze(cfg, { syntax, dataFile, timeout }) {
  const c = normalizeConfig(cfg);
  assertReady(c);
  const pyPath = writePyScript(c.workDir, pyAnalyze(syntax, dataFile));
  try {
    const { json, text } = decodeMixed(await runPython(c.pythonBat, pyPath, timeout || 180));
    if (json) {
      const data = JSON.parse(json);
      if (data.error) throw new Error(`SPSS error: ${data.error}`);
    }
    if (!text) throw new Error("SPSS ran but produced no output tables");
    return { ok: true, tables: text };
  } finally {
    try { fs.unlinkSync(pyPath); } catch {}
  }
}
