# dsh-thesis-workbench

Thesis / empirical-analysis workbench for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness): **run SPSS syntax, one-shot common statistics, extract structured tables via OMS, and profile `.sav` variables**. Ships a standalone zero-dependency SPSS MCP server.

论文/实证分析工作台：**SPSS 语法执行 + 常用统计一键跑 + OMS 结构化结果提取 + 数据集变量摸底**，自带独立零依赖 SPSS MCP server。

## 能力

| 工具 | 说明 |
| --- | --- |
| `spss_check` | 自检 SPSS 环境（stats.exe / statisticspython3.bat / 工作目录） |
| `spss_variables` | 列出 `.sav` 变量：名称/标签/类型/测度水平/案例数 |
| `spss_data` | 读取 `.sav` 案例数据（抽查、缺失与异常值检查） |
| `spss_run` | 直接执行 SPSS 语法文本（可选先 GET `.sav`） |
| `spss_run_file` | 执行 `.sps` 文件（自动修正相对路径 CD / GET FILE） |
| `spss_analyze` | 常用分析一键：frequencies / descriptives / crosstabs / ttest_independent / ttest_paired / oneway / correlation / regression |

`spss_analyze` 用 OMS（Output Management System）把结果表格导出为 XML 再解析，模型直接拿到论文可用的统计数字。

## 安装

```bash
dsh plugin --profile desktop add dsh-thesis-workbench
```

或在 DSH 插件市场里搜索 `dsh-thesis-workbench`。

安装后重启 DSH 生效。

## 前置依赖

- **SPSS 25-31** 已安装（需要 `stats.exe` + `statisticspython3.bat`）
  - 插件自动探测常见安装目录（`C:\Program Files\IBM\SPSS\Statistics\<版本>` 等）
  - 装在别处时设 `SPSS_PATH` / `SPSS_PYTHON_BAT` 环境变量，或在 profile 的 `cordis.patch.yml` 里覆写

## 配置

在 profile 自己的 `cordis.patch.yml` 里按 id 覆写（可选）：

```yaml
- id: thesis-workbench
  config:
    spssStats: "C:\\Program Files\\IBM\\SPSS\\Statistics\\26\\stats.exe"
    spssPythonBat: "C:\\Program Files\\IBM\\SPSS\\Statistics\\26\\statisticspython3.bat"
    workDir: ""                          # 留空则用 %TEMP%/dsh-thesis-spss
```

## 使用

1. `spss_check` 先自检环境；
2. `spss_variables` / `spss_data` 摸底数据结构（变量、类型、测度、案例数、抽样数据）；
3. `spss_analyze` 跑常见分析，或 `spss_run` / `spss_run_file` 跑自定义语法。

## MCP 独立使用

`mcp/server.js` 是零依赖 stdio MCP server，任何 MCP 客户端（Codex / Claude Code / opencode 等）可直接挂载：

```json
{
  "mcpServers": {
    "spss": {
      "command": "node",
      "args": ["<包目录>/mcp/server.js"],
      "env": {
        "SPSS_PATH": "C:\\Program Files\\IBM\\SPSS\\Statistics\\26\\stats.exe",
        "SPSS_PYTHON_BAT": "C:\\Program Files\\IBM\\SPSS\\Statistics\\26\\statisticspython3.bat"
      }
    }
  }
}
```

工具：`check` / `list_variables` / `get_data` / `run_syntax` / `run_syntax_file` / `analyze`。

## 许可

MIT
