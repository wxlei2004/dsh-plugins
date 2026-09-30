import { defineTool } from "@deepseek-ai/dsh-tools";
import z from "@deepseek-ai/schemastery";
import {
  check,
  runSyntax,
  runSyntaxFile,
  listVariables,
  getData,
  analyze,
} from "./spss-core.js";

export const name = "thesis-workbench";
export const inject = ["tools", "systemPrompt"];

export const Config = z.object({
  spssStats: z.string(),
  spssPythonBat: z.string(),
  workDir: z.string(),
});

const OUTPUT = {
  schema: { type: "object", additionalProperties: true },
  render: (_args, value) => [{ type: "text", text: JSON.stringify(value, null, 2) }],
};

function present(title, kind, rawInput) {
  return {
    title,
    kind,
    subtitle: rawInput,
    pending: "SPSS 运行中…",
  };
}

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

const GUIDE = `# 论文/实证分析工作台（thesis-workbench）
配合以下工具完成问卷/实证研究分析流程：
1. spss_check — 先自检 SPSS 环境是否就绪；
2. spss_variables / spss_data — 摸底 .sav 数据结构（变量、类型、测度、案例数、抽样数据）；
3. spss_analyze — 用内置模板跑常见分析（频数/描述/交叉表/独立样本t/配对t/单因素方差/相关/线性回归），返回结构化表格；
4. spss_run / spss_run_file — 自定义 SPSS 语法或 .sps 文件。
论文表述规则：
- 报告统计量必须来自工具返回的实际数值，禁止编造；
- 显著性表述用 APA 风格：p < .05 / .01 / .001，t(df)、F(df1, df2)、χ²(df)、r 均保留实际自由度；
- 结果章节按「描述统计 → 差异检验 → 相关/回归」组织，先给统计量再给结论；
- 数据编码（反向计分、均值合成、异常值处理）先确认再分析。`;

export function apply(ctx, config) {
  const cfg = config || {};

  ctx.systemPrompt.section({
    name: "tool:thesis-workbench",
    order: 130,
    text: GUIDE,
  });

  ctx.tools.register(defineTool({
    name: "spss_check",
    description:
      "自检本机 SPSS 环境：stats.exe 与 statisticspython3.bat 是否存在、工作目录是否可写。任何 SPSS 工具调用前先跑一次。",
    parameters: {},
    output: OUTPUT,
    execute: async () => check(cfg),
    presentCall: () => present("SPSS 环境自检", "read"),
  }));

  ctx.tools.register(defineTool({
    name: "spss_variables",
    description:
      "列出 .sav 数据文件的全部变量：名称、标签、类型（数值/字符串）、测度水平（scale/ordinal/nominal）、案例数。用于分析前摸底数据结构。",
    parameters: {
      sav_path: { type: "string", required: true, description: ".sav 数据文件绝对路径" },
    },
    output: OUTPUT,
    execute: (args) => listVariables(cfg, args),
    presentCall: (args) => present("SPSS 变量列表", "read", args.sav_path),
  }));

  ctx.tools.register(defineTool({
    name: "spss_data",
    description:
      "读取 .sav 数据文件中的案例数据（JSON 行），用于抽查原始数据、检查缺失与异常值。默认最多 100 行。",
    parameters: {
      sav_path: { type: "string", required: true, description: ".sav 数据文件绝对路径" },
      variables: { type: "array", items: { type: "string" }, description: "要读取的变量名（空 = 全部）" },
      max_rows: { type: "number", description: "最多返回行数（默认 100）" },
    },
    output: OUTPUT,
    execute: (args) => getData(cfg, args),
    presentCall: (args) => present("SPSS 数据抽查", "read", args.sav_path),
  }));

  ctx.tools.register(defineTool({
    name: "spss_run",
    description:
      "直接执行 SPSS 语法文本（spss.Submit），可先 GET 一个 .sav 文件再跑。输出为语法执行状态；若要拿到结构化结果表格，用 spss_analyze。",
    parameters: {
      syntax: { type: "string", required: true, description: "SPSS 语法内容（如 FREQUENCIES VARIABLES=Age.）" },
      data_file: { type: "string", description: "先加载的 .sav 文件绝对路径（可选）" },
      timeout: { type: "number", description: "超时秒数（默认 180）" },
    },
    output: OUTPUT,
    execute: (args) => runSyntax(cfg, args),
    presentCall: (args) => present("SPSS 执行语法", "other", (args.syntax || "").split("\n")[0]),
  }));

  ctx.tools.register(defineTool({
    name: "spss_run_file",
    description:
      "执行已有 .sps 语法文件。自动把语法中的相对路径（CD、GET FILE）改为以 .sps 所在目录为基准，便于整目录脚本直接跑。",
    parameters: {
      sps_path: { type: "string", required: true, description: ".sps 语法文件绝对路径" },
      timeout: { type: "number", description: "超时秒数（默认 180）" },
    },
    output: OUTPUT,
    execute: (args) => runSyntaxFile(cfg, args),
    presentCall: (args) => present("SPSS 执行语法文件", "other", args.sps_path),
  }));

  ctx.tools.register(defineTool({
    name: "spss_analyze",
    description:
      "常用统计分析一键执行：选择分析类型并给出变量，生成 SPSS 语法执行，返回 SPSS 输出的结果表格文本（可直接引用数值用于论文）。支持：frequencies 频数、descriptives 描述、crosstabs 交叉表(卡方)、ttest_independent 独立样本t、ttest_paired 配对t、oneway 单因素方差、correlation 相关、regression 线性回归。",
    parameters: {
      analysis: {
        type: "string",
        required: true,
        description:
          "分析类型：frequencies | descriptives | crosstabs | ttest_independent | ttest_paired | oneway | correlation | regression",
      },
      data_file: { type: "string", required: true, description: ".sav 数据文件绝对路径" },
      variables: { type: "string", required: true, description: "分析变量（逗号分隔，如 Gender,Age,Satisfaction）" },
      group: { type: "string", description: "分组变量（crosstabs / ttest_independent / oneway 用）" },
      group_values: { type: "string", description: "独立样本t 的分组值，逗号分隔两个值（如 1,2）" },
      depvar: { type: "string", description: "回归因变量（regression 用）" },
      indepvars: { type: "string", description: "回归自变量，逗号分隔（regression 用）" },
    },
    output: OUTPUT,
    async execute(args) {
      const tpl = ANALYZE_TEMPLATES[args.analysis];
      if (!tpl) {
        throw new Error(
          `未知分析类型: ${args.analysis}。可用: ${Object.keys(ANALYZE_TEMPLATES).join(", ")}`
        );
      }
      const vars = (args.variables || "").split(",").map((s) => s.trim()).filter(Boolean).join(" ");
      const varsComma = (args.variables || "").split(",").map((s) => s.trim()).filter(Boolean).join(",");
      let syntax;
      switch (args.analysis) {
        case "frequencies":
        case "descriptives":
        case "correlation":
          syntax = tpl(vars);
          break;
        case "crosstabs":
          if (!args.group) throw new Error("crosstabs 需要 group（列变量）");
          syntax = tpl(vars, args.group);
          break;
        case "ttest_independent": {
          if (!args.group) throw new Error("ttest_independent 需要 group（分组变量）");
          const gv = (args.group_values || "1,2").split(",").map((s) => s.trim());
          if (gv.length < 2) throw new Error("group_values 需要两个值，如 1,2");
          syntax = tpl(vars, args.group, gv[0], gv[1]);
          break;
        }
        case "ttest_paired": {
          const parts = (args.variables || "").split(",").map((s) => s.trim()).filter(Boolean);
          if (parts.length < 2) throw new Error("ttest_paired 需要至少两个变量（逗号分隔的前两个作为配对）");
          syntax = tpl(parts[0], parts.slice(1).join(" "));
          break;
        }
        case "oneway":
          if (!args.group) throw new Error("oneway 需要 group（分组变量）");
          syntax = tpl(vars, args.group);
          break;
        case "regression":
          if (!args.depvar) throw new Error("regression 需要 depvar（因变量）");
          const ind = (args.indepvars || "").split(",").map((s) => s.trim()).filter(Boolean).join(" ");
          if (!ind) throw new Error("regression 需要 indepvars（自变量）");
          syntax = tpl(args.depvar, ind);
          break;
        default:
          throw new Error(`未知分析类型: ${args.analysis}`);
      }
      return analyze(cfg, { syntax, dataFile: args.data_file });
    },
    presentCall: (args) => present(`SPSS ${args.analysis}`, "other", args.variables),
  }));
}



