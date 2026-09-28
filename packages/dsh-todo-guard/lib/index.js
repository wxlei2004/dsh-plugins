/**
 * dsh-todo-guard — 任务清单陈旧度守卫
 *
 * 问题：模型建了清单后就忘了回写，界面上那份快照永远停在初始状态。
 * 后台任务通知以 user 角色注入时不触发 turn/start，清单也不会被清空，
 * 于是陈旧清单会一直挂着，看起来像 UI 卡住了。
 *
 * 做法：监听会话事件，统计「上一次 todo_write 之后又干了多少活」。
 * 在 agent/pre-step 时若超过阈值，就往本轮追加一条 user 角色提醒，
 * 让模型在继续干活前先把清单更新掉。纯提示，不阻断、不改工具行为。
 *
 * @module dsh-todo-guard
 */
import z from "@deepseek-ai/schemastery";
import { createUserMessage } from "@deepseek-ai/dsh-llm";

export const name = "todo-guard";
export const inject = ["sessionProjections"];

/** 每隔多少次“计步事件”才检查一次，避免把热路径搞重。 */
const DEFAULT_EVERY = 12;

/** 判断一个事件是否算“又干了一步活”。 */
const WORK_EVENTS = new Set([
  "tool/call",
  "assistant/message",
]);

export const Config = z.object({
  /** 关掉整个守卫。 */
  disabled: z.boolean().default(false),
  /** 距上次 todo_write 超过多少个工作事件就提醒。0 = 每次 pre-step 都查。 */
  every: z.number().step(1).min(0).default(DEFAULT_EVERY),
  /** 一次提醒之后，至少再过多少轮才允许再提醒（避免刷屏）。 */
  cooldown: z.number().step(1).min(1).default(2),
});

/**
 * 从投影里取出当前清单。
 * @param projections - sessionProjections 服务。
 * @param session - 目标会话。
 * @returns 清单数组，或 null（还没写过）。
 */
function readTodos(projections, session) {
  try {
    const state = projections?.stateOf?.(session, "todos");
    return Array.isArray(state) ? state : null;
  } catch {
    return null;
  }
}

/**
 * 把清单压缩成一行摘要，给模型看“你上次写的还长这样”。
 * @param todos - 清单。
 * @returns 摘要文本。
 */
function summarize(todos) {
  if (!todos || todos.length === 0) return "（空）";
  return todos
    .map((t) => {
      const mark = t.status === "completed" ? "x" : t.status === "in_progress" ? "~" : " ";
      return `[${mark}] ${t.content}`;
    })
    .join("；");
}

/**
 * 判断这份清单是否值得提醒：只要还有没做完的条目，且确实隔了很久没更新，就提醒。
 *
 * 注意刻意不要求「没有 in_progress」——实际卡住的形态恰恰是模型留着一个
 * 很久以前的 in_progress 再也不动，那种情况更需要提醒。全部 completed
 * 或本来就没清单，都不提醒。
 * @param todos - 清单。
 * @returns 是否需要提醒。
 */
function needsNudge(todos) {
  if (!todos || todos.length === 0) return false;
  const remaining = todos.filter((t) => t.status !== "completed").length;
  return remaining > 0;
}

/**
 * 注册守卫。
 * @param ctx - 插件上下文。
 * @param config - 已规范化的配置。
 */
export function apply(ctx, config) {
  if (config.disabled) return;

  const every = config.every;
  const cooldown = config.cooldown;

  /**
   * 每个会话的跟踪状态。
   * @type {WeakMap<object, {count: number, lastWrites: number, sinceNudge: number, total: number}>}
   */
  const tracked = new WeakMap();

  /**
   * 取（或建）某会话的跟踪状态。
   * @param session - 目标会话。
   * @returns 跟踪状态。
   */
  function stateFor(session) {
    let s = tracked.get(session);
    if (!s) {
      s = { count: 0, lastWrites: -1, sinceNudge: 99, total: 0 };
      tracked.set(session, s);
    }
    return s;
  }

  ctx.on("session/event", (session, event) => {
    const s = stateFor(session);
    if (event.type === "todo/write") {
      s.count = 0;
      s.sinceNudge = 0;
      s.total += 1;
      s.lastWrites = s.total;
      return;
    }
    if (event.type === "turn/start") {
      s.count = 0;
      s.sinceNudge += 1;
      return;
    }
    if (WORK_EVENTS.has(event.type)) {
      s.count += 1;
      s.sinceNudge += 1;
    }
  });

  ctx.on(
    "agent/pre-step",
    async ({ agent }, next) => {
      const decision = await next();
      if (decision.kind === "reject") return decision;

      const session = agent?.session;
      if (!session) return decision;

      const s = stateFor(session);
      if (every > 0 && s.count < every) return decision;
      if (s.sinceNudge < cooldown) return decision;

      const todos = readTodos(ctx.sessionProjections, session);
      if (!needsNudge(todos)) return decision;

      s.count = 0;
      s.sinceNudge = 0;

      const notice = createUserMessage({
        content: [
          {
            type: "text",
            text:
              "[todo-guard] 你已经连续 " +
              (every > 0 ? String(every) : "若干") +
              " 次以上的工具调用没有更新任务清单了，而清单里还有没做完的条目。\n" +
              "清单当前是：" +
              summarize(todos) +
              "\n请先调用 todo_write 把它更新到真实进度（做完的标 completed，正在做的标 in_progress），再继续干活。" +
              "如果这些条目其实都已经完成，就一次性全标 completed；如果计划变了，就重写整张表。",
          },
        ],
        source: {
          kind: "plugin",
          plugin: "todo-guard",
          form: "notice",
          summary: "任务清单提醒",
        },
      });

      return { ...decision, messages: [...decision.messages, notice] };
    },
  );
}
