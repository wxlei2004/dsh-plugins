#!/usr/bin/env node
/**
 * @dsh-thesis/spss-mcp — zero-dependency stdio MCP server.
 *
 * Exposes the same SPSS engine as the DSH plugin (lib/spss-core.js) over the
 * Model Context Protocol, usable from Codex / Claude Code / opencode / any
 * MCP client:
 *
 *   tools:
 *     check            — SPSS environment self-check
 *     list_variables   — variables in a .sav file
 *     get_data         — case data rows as JSON
 *     run_syntax       — run SPSS syntax text (optional GET FILE first)
 *     run_syntax_file  — run an existing .sps file
 *     analyze          — run a common analysis template via OMS and return structured tables
 *
 * Environment:
 *   SPSS_PATH        — stats.exe location
 *   SPSS_PYTHON_BAT  — statisticspython3.bat location
 *   SPSS_WORK_DIR    — temp working dir (default %TEMP%/dsh-thesis-spss)
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  check,
  runSyntax,
  runSyntaxFile,
  listVariables,
  getData,
  analyze,
} from "../lib/spss-core.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const ANALYZE_TEMPLATES = {
  frequencies: (v) => `FREQUENCIES VARIABLES=${v}.\n`,
  descriptives: (v) => `DESCRIPTIVES VARIABLES=${v}.\n`,
  crosstabs: (v, g) => `CROSSTABS /TABLES=${v} BY ${g} /STATISTICS=CHISQ /CELLS=COUNT ROW COLUMN.\n`,
  ttest_independent: (v, g, a, b) =>
    `T-TEST GROUPS=${g}(${a} ${b}) /MISSING=ANALYSIS /VARIABLES=${v} /CRITERIA=CI(.95).\n`,
  ttest_paired: (v1, v2) => `T-TEST PAIRS=${v1} WITH ${v2} (PAIRED) /CRITERIA=CI(.95).\n`,
  oneway: (v, g) => `ONEWAY ${v} BY ${g} /STATISTICS=DESCRIPTIVES /MISSING ANALYSIS.\n`,
  correlation: (v) => `CORRELATIONS /VARIABLES=${v} /PRINT=TWOTAIL NOSIG /MISSING=PAIRWISE.\n`,
  regression: (dep, indep) =>
    `REGRESSION /DESCRIPTIVES MEAN STDDEV CORR SIG N /MISSING LISTWISE /STATISTICS COEFF OUTS R ANOVA /CRITERIA=PIN(.05) POUT(.10) /NOORIGIN /DEPENDENT ${dep} /METHOD=ENTER ${indep}.\n`,
};

function resolveConfig() {
  return {
    spssStats: process.env.SPSS_PATH || undefined,
    spssPythonBat: process.env.SPSS_PYTHON_BAT || undefined,
    workDir: process.env.SPSS_WORK_DIR || undefined,
  };
}

const TOOLS = [
  {
    name: "check",
    description: "SPSS 环境自检：stats.exe / statisticspython3.bat 是否存在、工作目录。任何 SPSS 工具前先调用。",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "list_variables",
    description: "列出 .sav 数据文件全部变量（名称/标签/类型/测度水平/案例数）。",
    inputSchema: {
      type: "object",
      properties: {
        sav_path: { type: "string", description: ".sav 数据文件绝对路径" },
      },
      required: ["sav_path"],
    },
  },
  {
    name: "get_data",
    description: "读取 .sav 案例数据为 JSON 行（默认 100 行），用于抽查数据、检查缺失/异常值。",
    inputSchema: {
      type: "object",
      properties: {
        sav_path: { type: "string", description: ".sav 数据文件绝对路径" },
        variables: { type: "array", items: { type: "string" }, description: "变量名（空 = 全部）" },
        max_rows: { type: "number", description: "最多行数（默认 100）" },
      },
      required: ["sav_path"],
    },
  },
  {
    name: "run_syntax",
    description: "执行 SPSS 语法文本（spss.Submit），可先 GET .sav。输出执行状态；结构化结果用 analyze。",
    inputSchema: {
      type: "object",
      properties: {
        syntax: { type: "string", description: "SPSS 语法内容" },
        data_file: { type: "string", description: "先加载的 .sav（可选）" },
        timeout: { type: "number", description: "超时秒数（默认 180）" },
      },
      required: ["syntax"],
    },
  },
  {
    name: "run_syntax_file",
    description: "执行已有 .sps 文件（自动把 CD / GET FILE 相对路径改为 .sps 所在目录基准）。",
    inputSchema: {
      type: "object",
      properties: {
        sps_path: { type: "string", description: ".sps 文件绝对路径" },
        timeout: { type: "number", description: "超时秒数（默认 180）" },
      },
      required: ["sps_path"],
    },
  },
  {
    name: "analyze",
    description:
      "常用分析一键执行（返回 SPSS 结果表格文本）。类型：frequencies / descriptives / crosstabs / ttest_independent / ttest_paired / oneway / correlation / regression。返回 {ok, tables}。",
    inputSchema: {
      type: "object",
      properties: {
        analysis: { type: "string", description: "分析类型（见描述）" },
        data_file: { type: "string", description: ".sav 数据文件绝对路径" },
        variables: { type: "string", description: "分析变量，逗号分隔" },
        group: { type: "string", description: "分组变量（crosstabs/ttest_independent/oneway）" },
        group_values: { type: "string", description: "独立样本t 分组值，如 1,2" },
        depvar: { type: "string", description: "回归因变量" },
        indepvars: { type: "string", description: "回归自变量，逗号分隔" },
      },
      required: ["analysis", "data_file", "variables"],
    },
  },
];

function buildAnalyzeSyntax(args) {
  const tpl = ANALYZE_TEMPLATES[args.analysis];
  if (!tpl) {
    throw new Error(`未知分析类型: ${args.analysis}。可用: ${Object.keys(ANALYZE_TEMPLATES).join(", ")}`);
  }
  const vars = (args.variables || "").split(",").map((s) => s.trim()).filter(Boolean).join(" ");
  switch (args.analysis) {
    case "frequencies":
    case "descriptives":
    case "correlation":
      return tpl(vars);
    case "crosstabs":
      if (!args.group) throw new Error("crosstabs 需要 group");
      return tpl(vars, args.group);
    case "ttest_independent": {
      if (!args.group) throw new Error("ttest_independent 需要 group");
      const gv = (args.group_values || "1,2").split(",").map((s) => s.trim());
      return tpl(vars, args.group, gv[0], gv[1]);
    }
    case "ttest_paired": {
      const parts = (args.variables || "").split(",").map((s) => s.trim()).filter(Boolean);
      if (parts.length < 2) throw new Error("ttest_paired 需要至少两个变量");
      return tpl(parts[0], parts.slice(1).join(" "));
    }
    case "oneway":
      if (!args.group) throw new Error("oneway 需要 group");
      return tpl(vars, args.group);
    case "regression": {
      if (!args.depvar) throw new Error("regression 需要 depvar");
      const ind = (args.indepvars || "").split(",").map((s) => s.trim()).filter(Boolean).join(" ");
      if (!ind) throw new Error("regression 需要 indepvars");
      return tpl(args.depvar, ind);
    }
    default:
      throw new Error(`未知分析类型: ${args.analysis}`);
  }
}

async function callTool(name, args) {
  const cfg = resolveConfig();
  switch (name) {
    case "check":
      return { ok: true, ...(await check(cfg)) };
    case "list_variables":
      return await listVariables(cfg, { savPath: args.sav_path });
    case "get_data":
      return await getData(cfg, { savPath: args.sav_path, variables: args.variables, maxRows: args.max_rows });
    case "run_syntax":
      return { output: await runSyntax(cfg, { syntax: args.syntax, dataFile: args.data_file, timeout: args.timeout }) };
    case "run_syntax_file":
      return { output: await runSyntaxFile(cfg, { spsPath: args.sps_path, timeout: args.timeout }) };
    case "analyze":
      return await analyze(cfg, { syntax: buildAnalyzeSyntax(args), dataFile: args.data_file });
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

const readline = await import("node:readline");
const rl = readline.createInterface({ input: process.stdin, terminal: false });

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + "\n");
}

function sendError(id, message) {
  send({ jsonrpc: "2.0", id, error: { code: -32603, message } });
}

function sendResult(id, result) {
  send({ jsonrpc: "2.0", id, result });
}

rl.on("line", async (line) => {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  if (msg.method === "initialize") {
    sendResult(msg.id, {
      protocolVersion: "2024-11-05",
      capabilities: { tools: {} },
      serverInfo: { name: "dsh-thesis-spss-mcp", version: "0.1.0" },
    });
    return;
  }
  if (msg.method === "notifications/initialized" || msg.method === "ping") {
    return;
  }
  if (msg.method === "tools/list") {
    sendResult(msg.id, { tools: TOOLS });
    return;
  }
  if (msg.method === "tools/call") {
    const { name, arguments: args } = msg.params || {};
    try {
      const result = await callTool(name, args || {});
      sendResult(msg.id, { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] });
    } catch (e) {
      sendError(msg.id, e.message || String(e));
    }
    return;
  }
});

process.stdin.resume();

send({
  jsonrpc: "2.0",
  method: "notifications/initialized",
  params: {},
});
