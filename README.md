# dsh-plugins

DeepSeek Harness 插件集合 / A collection of DeepSeek Harness plugins.

## 插件列表

| 插件 | 说明 | 版本 |
|---|---|---|
| [`dsh-todo-guard`](./packages/dsh-todo-guard) | 任务清单陈旧度守卫：模型忘记回写清单时自动提醒 | 0.1.0 |

## 安装

每个插件都可以单独安装。

### 通过插件市场

在 DSH 的插件市场里搜索插件名。

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
│   └── dsh-todo-guard/         # 每个插件一个子目录
│       ├── lib/                # 源码
│       ├── cordis.patch.yml    # bundle patch（挂载声明）
│       ├── package.json
│       ├── README.md
│       └── LICENSE
├── .gitignore
└── README.md
```

每个子包都是**独立的 npm 包**，可以单独发布到 npm 或从 GitHub subpath 安装。

## 开发

子包无构建步骤（纯 JS），改完直接生效。

验证语法：

```bash
node --check packages/dsh-todo-guard/lib/index.js
```

## 许可

MIT
