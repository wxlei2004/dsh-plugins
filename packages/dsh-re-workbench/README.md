# dsh-re-workbench

Reverse-engineering workbench for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness): bridges your local **IDA Pro** into the harness as `mcp__ida__*` tools, with an environment self-check.

逆向分析工作台：把本机 **IDA Pro** 桥接进 DSH，工具以 `mcp__ida__*` 注册到模型侧，自带环境自检。

## 能力

| 工具 | 说明 |
| --- | --- |
| `re_check` | 逆向环境自检：python / ida_pro_mcp / idalib 可用性，IDA RPC 端口探测 |
| `re_open` | 指定/切换分析目标（idalib 无头模式），写目标文件并触发 MCP 重连 |
| `re_status` | 查看当前目标与 MCP 桥状态 |

MCP server 透传 `ida-pro-mcp` 全部工具（反编译、xref、重命名、注释等），工具名以 `mcp__ida__*` 注册。

## 两种模式

`mcp/server.js` 自动选择：

- **idalib 无头模式（推荐）**：设了分析目标就走这里。进程内加载分析，无需打开 IDA GUI。
- **GUI 模式（回退）**：没设目标时连 IDA 插件 RPC（默认 `127.0.0.1:13337`），需要 IDA 已打开并加载数据库、`mcp-plugin.py` 在运行。

## 安装

```bash
dsh plugin --profile desktop add dsh-re-workbench
```

或在 DSH 插件市场里搜索 `dsh-re-workbench`。

安装后重启 DSH 生效。

## 前置依赖

- **Python 3.10+**（自动从 PATH 探测；也可设 `RE_PYTHON` 环境变量指定）
- `pip install ida-pro-mcp`（idalib 模式还需要本机装有 IDA Pro 9.x，`idapro` 模块由 IDA 提供）
- GUI 模式：IDA Pro 开着，`mcp-plugin.py` 运行中（监听 13337）

## 配置

在 profile 自己的 `cordis.patch.yml` 里按 id 覆写（可选）：

```yaml
- id: re-workbench
  config:
    pythonPath: ""                       # 留空则自动探测
    idaRpc: "http://127.0.0.1:13337"
    target: ""                           # 设了就默认走 idalib 无头模式
```

也可用环境变量：`RE_PYTHON` / `RE_IDA_RPC` / `RE_TARGET` / `RE_TARGET_FILE` / `RE_UNSAFE` / `RE_MODE`。

## 使用

1. 新会话里让模型调 `re_check` 确认环境；
2. idalib 模式：调 `re_open` 指定目标文件（大文件首次分析要等几十秒）；
   GUI 模式：确认目标已在 IDA Pro 中打开；
3. 之后用 `mcp__ida__*` 工具分析：看 PE/ELF 头与导入表 → 定位入口/关键函数 → 反编译 → 追 xref → 重命名/注释。

## MCP 独立使用

`mcp/server.js` 是零依赖 stdio MCP server，任何 MCP 客户端可直接挂载：

```json
{
  "mcpServers": {
    "ida": {
      "command": "node",
      "args": ["<包目录>/mcp/server.js"],
      "env": {
        "RE_TARGET": "C:\\path\\to\\target.exe"
      }
    }
  }
}
```

## 许可

MIT
