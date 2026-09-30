# dsh-plugins

DeepSeek Harness 插件集合 / A collection of DeepSeek Harness plugins.

## 插件列表

| 插件 | 说明 | 版本 |
|---|---|---|
| [`dsh-todo-guard`](./packages/dsh-todo-guard) | 任务清单陈旧度守卫：模型忘记回写清单时自动提醒 | 0.1.0 |
| [`dsh-re-workbench`](./packages/dsh-re-workbench) | 逆向分析工作台：IDA Pro 桥接（idalib 无头 / GUI RPC 双模式） | 0.1.0 |
| [`dsh-thesis-workbench`](./packages/dsh-thesis-workbench) | 论文/实证分析工作台：SPSS 执行 + 常用统计一键跑 + OMS 结构化结果 | 0.1.0 |

## 安装

每个插件都可以单独安装。

### 通过插件市场

在 DSH 的插件市场里搜索插件名。

### 从 npm 安装

```bash
dsh plugin --profile desktop add <plugin-name>
```

例如：

```bash
dsh plugin --profile desktop add dsh-todo-guard
dsh plugin --profile desktop add dsh-re-workbench
dsh plugin --profile desktop add dsh-thesis-workbench
```

### 从 GitHub 直接安装

```bash
dsh plugin --profile desktop add github:wxlei2004/dsh-plugins#path:/packages/<plugin-name>
```

例如：

```bash
dsh plugin --profile desktop add github:wxlei2004/dsh-plugins#path:/packages/dsh-todo-guard
```

### 本地开发安装

```bash
git clone https://github.com/wxlei2004/dsh-plugins.git
cd dsh-plugins
dsh plugin --profile desktop add link:$(pwd)/packages/dsh-todo-guard
```

## 仓库结构

```
dsh-plugins/
├── packages/
│   ├── dsh-todo-guard/         # 每个插件一个子目录
│   │   ├── lib/                # 源码
│   │   ├── cordis.patch.yml    # bundle patch（挂载声明）
│   │   ├── package.json
│   │   ├── README.md
│   │   └── LICENSE
│   ├── dsh-re-workbench/
│   │   ├── lib/                # 插件本体（re_check / re_open / re_status）
│   │   ├── mcp/                # 独立 MCP server（零依赖 stdio）
│   │   ├── cordis.patch.yml
│   │   └── ...
│   └── dsh-thesis-workbench/
│       ├── lib/                # 插件本体（SPSS 工具集）
│       ├── mcp/                # 独立 MCP server（零依赖 stdio）
│       ├── cordis.patch.yml
│       └── ...
├── submission/                 # 插件市场提交条目
├── .gitignore
└── README.md
```

每个子包都是**独立的 npm 包**，可以单独发布到 npm 或从 GitHub subpath 安装。

## 开发

子包无构建步骤（纯 JS），改完直接生效。

验证语法：

```bash
node --check packages/dsh-todo-guard/lib/index.js
node --check packages/dsh-re-workbench/lib/index.js
node --check packages/dsh-re-workbench/mcp/server.js
node --check packages/dsh-thesis-workbench/lib/index.js
node --check packages/dsh-thesis-workbench/mcp/server.js
```

## 许可

MIT
