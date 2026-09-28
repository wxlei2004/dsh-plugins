# dsh-todo-guard

**任务清单陈旧度守卫 / Task-list staleness guard for DeepSeek Harness**

> 模型建了清单却忘记回写时，在下一步之前自动追加一条提醒，让清单回到真实进度。

---

## 它解决什么问题

DeepSeek Harness 的 `todo_write` 工具是**整表替换**语义：每次调用都要重发完整列表，UI 只渲染模型最后一次写的快照。

实际使用中会出现这种情况：

```
模型建了清单 → 开始干活 → 连续调用几十次工具 → 一次都没回写清单
                                                        ↓
                                        UI 上那份清单永远停在初始状态
```

**看起来像 UI 卡住了，其实是模型忘了回写。**

更糟的是后台任务通知（`background job pwsh-3 finished...`）会以 **user 角色**注入到当前回合，但**不触发 `turn/start`** —— 所以清单也不会被清空，一份陈旧清单会跨很多轮一直挂着。

## 它做什么

监听会话事件，统计「上一次 `todo_write` 之后又干了多少活」。超过阈值时，在 `agent/pre-step` 阶段往本轮追加一条提醒消息：

```
[todo-guard] 你已经连续 12 次以上的工具调用没有更新任务清单了，而清单里还有没做完的条目。
清单当前是：[x] 步骤 A；[~] 步骤 B；[ ] 步骤 C
请先调用 todo_write 把它更新到真实进度（做完的标 completed，正在做的标 in_progress），再继续干活。
```

**纯提示，不阻断、不改工具行为、不改任何数据。**

## 安装

### 通过插件市场

在 DSH 的插件市场里搜索 `dsh-todo-guard` 安装。

### 通过命令行

```bash
dsh plugin --profile desktop add dsh-todo-guard
```

### 从 GitHub 直接安装

```bash
dsh plugin --profile desktop add github:wxlei2004/dsh-plugins#path:/packages/dsh-todo-guard
```

## 配置

在 profile 的 `cordis.patch.yml` 里覆盖：

```yaml
- id: todo-guard
  config:
    disabled: false
    every: 12
    cooldown: 2
```

| 字段 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `disabled` | boolean | `false` | 关掉整个守卫 |
| `every` | number | `12` | 距上次 `todo_write` 超过多少个工作事件就提醒。`0` = 每次 pre-step 都检查 |
| `cooldown` | number | `2` | 一次提醒之后，至少再过多少轮才允许再提醒（防刷屏） |

**计步事件**：`tool/call` 和 `assistant/message`。`turn/start` 和 `todo/write` 会重置计数。

### 调参建议

| 场景 | 建议 |
|---|---|
| 觉得提醒太频繁 | 调大 `every`（如 `20`） |
| 长任务、步骤粒度粗 | 调大 `every` + `cooldown` |
| 想更早介入 | 调小 `every`（如 `6`） |
| 完全不想要 | `disabled: true` |

## 工作原理

```
session/event 监听
  ├─ todo/write       → count = 0, sinceNudge = 0
  ├─ turn/start       → count = 0, sinceNudge += 1
  └─ tool/call        → count += 1, sinceNudge += 1
     assistant/message

agent/pre-step 钩子
  ├─ decision.kind === "reject"     → 放行
  ├─ count < every                  → 放行
  ├─ sinceNudge < cooldown          → 放行
  ├─ 清单为空或全部 completed        → 放行
  └─ 否则 → 追加一条 user 角色提醒消息
```

判断条件刻意**不要求「没有 in_progress」** —— 实际卡住的形态恰恰是模型留着一个很久以前的 `in_progress` 再也不动，那种情况更需要提醒。

## 与 `dsh-tool-todo` 补丁的区别

| | 本插件 | `dsh-tool-todo` 行为补丁 |
|---|---|---|
| 层次 | **行为层**（提醒模型） | **数据层**（改投影逻辑） |
| 侵入性 | 零（不改任何内置模块） | 需要替换内置包 |
| 升级安全 | ✅ 不受 DSH 升级影响 | ❌ 升级会被覆盖 |
| 效果 | 模型被提醒后自己回写 | 直接改变清单渲染结果 |

两者互补，可以同时使用。

## 兼容性

| 项 | 值 |
|---|---|
| DSH | `^0.1.0-rc.6`（peer） |
| Node | `>=20` |
| 平台 | 全部（纯 JS，无原生依赖） |

## 许可

MIT
