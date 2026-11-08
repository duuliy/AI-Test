/**
 * Day 2: 状态定义 —— 普通字段（LastValue）与 reducer 字段（ReducedValue）
 *
 * 本地安装的 @langchain/langgraph 是 0.2.x（v1 的 `StateSchema` / `ReducedValue` /
 * `MessagesValue` 在 0.2.x 中不存在），因此按本地类型定义使用等价写法：
 *
 *   v1 写法                        → 0.2.x 等价写法
 *   new StateSchema({...})         → z.object({...}) + StateGraph(schema)
 *   ReducedValue(Input, {reducer}) → withLangGraph(存储类型 schema, {
 *                                       reducer: { schema: 输入类型, fn: 合并函数 },
 *                                       default: ...
 *                                     })
 *   MessagesValue                  → withLangGraph(..., { reducer: messagesStateReducer })
 *
 * 两种字段的差别：
 * - 普通字段（没有 reducer）走 LastValue 通道：节点返回什么就覆盖什么，后写覆盖先写
 * - reducer 字段走 BinaryOperatorAggregate 通道：节点只返回「增量」，由 fn 把增量合并进当前值
 */

import { z } from "zod";
import type { BaseMessage } from "@langchain/core/messages";
import type { Messages } from "@langchain/langgraph";
import { messagesStateReducer } from "@langchain/langgraph";
import { withLangGraph } from "@langchain/langgraph/zod";

export const Day2StateSchema = z.object({
  /**
   * 普通字段：LastValue，后写覆盖先写。
   * 存储类型 / 输入类型都是 string。
   * 本图的 join 节点从 configurable 读到 userId 后写入；没传时由节点回落到 "anonymous"。
   * 注意：0.2.x 的 LastValue 通道不会初始化这里的 zod default，
   * 所以 defaultValue 主要作为 schema 语义说明，真正的回落写在 joinNode 里。
   */
  userId: z.string().default("anonymous"),

  /**
   * 消息字段：reducer。
   * - 存储类型：BaseMessage[]（状态里始终是完整消息数组）
   * - 输入类型：Messages（节点可以返回单条消息、消息数组或消息字面量）
   * - 合并规则：messagesStateReducer，自动追加（还能处理 AIMessageChunk 拼接和 RemoveMessage）
   */
  messages: withLangGraph(z.custom<BaseMessage[]>(), {
    reducer: {
      schema: z.custom<Messages>(),
      fn: messagesStateReducer,
    },
    default: () => [],
  }),

  /**
   * 对照组：普通数组字段，没有 reducer。
   * - 存储类型 / 输入类型都是 string[]
   * - 两个并行分支都写它时，只有最后一个分支的结果留下（覆盖）
   */
  plainMessages: z.array(z.string()).default([]),

  /**
   * 步骤轨迹：reducer。
   * - 存储类型：string[]（累积后的数组）
   * - 输入类型：string（节点只写单个步骤，不拼数组）
   * - 合并规则：append
   */
  steps: withLangGraph(z.array(z.string()), {
    reducer: {
      schema: z.string(),
      fn: (left: string[], right: string) => left.concat(right),
    },
    default: () => [],
  }),

  /**
   * 发现列表：reducer + 去重。
   * - 存储类型：string[]
   * - 输入类型：string
   * - 合并规则：已存在就不追加
   */
  findings: withLangGraph(z.array(z.string()), {
    reducer: {
      schema: z.string(),
      fn: (left: string[], right: string) =>
        left.includes(right) ? left : left.concat(right),
    },
    default: () => [],
  }),

  /**
   * 分数：reducer 取最大值，而不是后写覆盖。
   * - 存储类型：number
   * - 输入类型：number
   * - 合并规则：Math.max
   */
  score: withLangGraph(z.number(), {
    reducer: {
      schema: z.number(),
      fn: (left: number, right: number) => Math.max(left, right),
    },
    default: () => 0,
  }),
});

/** 完整状态的类型（读的状态，reducer 字段是合并后的存储类型） */
export type Day2State = z.infer<typeof Day2StateSchema>;

/** 节点允许返回的部分更新类型（reducer 字段这里是输入/增量类型） */
export type Day2Update = z.input<typeof Day2StateSchema>;
