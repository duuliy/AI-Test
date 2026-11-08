/**
 * Day 3: 手写 ReAct 循环图
 *
 * 图结构：
 *   START → model ──(有 tool_calls)──→ tools ──→ model
 *                └──(无 tool_calls)──→ END
 *
 * 知识点：
 * - bindTools 只是把工具定义（name / description / schema）发给模型，不会执行工具
 * - 路由函数只读 State，返回节点名或 END，不能有副作用
 * - 循环的终止条件：模型不再返回 tool_calls，路由函数返回 END
 * - toolsNode 只处理最后一条 AIMessage 的 tool_calls，并把结果构造成 ToolMessage
 */

import { z } from "zod";
import { StateGraph, START, END, MessagesZodState } from "@langchain/langgraph";
import { isAIMessage } from "@langchain/core/messages";
import { AIMessage, ToolMessage } from "@langchain/core/messages";
import type { BaseMessage } from "@langchain/core/messages";
import { initModel } from "./model.js";
import { tools, toolMap } from "./tools.js";

// ─────────────────────────────────────────────
// 1. 定义状态
// ─────────────────────────────────────────────

/**
 * MessagesZodState 等价于给 messages 挂上 messagesStateReducer：
 * 节点返回 messages 增量，通道会自动追加（并合并 AIMessageChunk）
 *
 * rounds 是普通字段（LastValue）：模型节点返回什么就覆盖什么
 *
 * 注意：当前安装的 @langchain/langgraph 是 0.2.x，没有 v1 的 MessagesValue，
 * 这里用 MessagesZodState 作为等价的消息通道
 */
const ReactState = MessagesZodState.extend({
  /** 模型节点执行了几轮，用于观察循环次数 */
  rounds: z.number().default(0),
});

type ReactStateType = z.infer<typeof ReactState>;

// ─────────────────────────────────────────────
// 2. 节点
// ─────────────────────────────────────────────

/**
 * 模型节点：bindTools 后调用模型，把返回的 AIMessage 追加进 messages
 */
async function modelNode(state: ReactStateType): Promise<Partial<ReactStateType>> {
  const { model } = initModel();
  if (!model.bindTools) {
    throw new Error("当前模型不支持 bindTools，无法进行工具调用");
  }

  // bindTools 只发工具定义，工具执行发生在 toolsNode 里
  const boundModel = model.bindTools(tools);
  const response = await boundModel.invoke(state.messages);

  if (!isAIMessage(response)) {
    throw new Error("模型返回了非 AIMessage");
  }

  return {
    messages: [response],
    // 0.2.x 的 zod 默认值不会自动写入通道，首次读可能是 undefined
    rounds: (state.rounds ?? 0) + 1,
  };
}

/**
 * 工具节点：执行最后一条 AIMessage 的 tool_calls
 * - 未知工具 → 返回「未知工具：xxx」
 * - 工具抛错 → 转成错误字符串，不向上抛
 * - tool_call_id 必须用对应 tool_call.id，否则模型无法把结果和调用对上
 */
async function toolsNode(state: ReactStateType): Promise<Partial<ReactStateType>> {
  const lastMessage = state.messages.at(-1);
  if (!lastMessage || !isAIMessage(lastMessage)) {
    return {};
  }

  const toolCalls = lastMessage.tool_calls ?? [];
  const results: ToolMessage[] = [];

  for (const [index, toolCall] of toolCalls.entries()) {
    // OpenAI 兼容接口都会返回 id；极少数 provider 省略时用位置兜底
    const toolCallId = toolCall.id ?? `call_${index}`;
    const item = toolMap[toolCall.name];

    if (!item) {
      results.push(
        new ToolMessage({
          content: `未知工具：${toolCall.name}`,
          tool_call_id: toolCallId,
          name: toolCall.name,
        })
      );
      continue;
    }

    try {
      const output: unknown = await item.invoke(toolCall.args);
      results.push(
        new ToolMessage({
          content: stringifyToolOutput(output),
          tool_call_id: toolCallId,
          name: toolCall.name,
        })
      );
    } catch (error) {
      // 工具异常不抛出，转成文本回填给模型，让图继续走完
      const message = error instanceof Error ? error.message : String(error);
      results.push(
        new ToolMessage({
          content: `工具执行失败：${message}`,
          tool_call_id: toolCallId,
          name: toolCall.name,
          status: "error",
        })
      );
    }
  }

  return { messages: results };
}

/**
 * 工具输出统一转成字符串：ToolMessage.content 需要是 string 或 content blocks
 */
function stringifyToolOutput(output: unknown): string {
  if (typeof output === "string") return output;
  return JSON.stringify(output) ?? String(output);
}

// ─────────────────────────────────────────────
// 3. 路由函数
// ─────────────────────────────────────────────

/**
 * 只读 State，不做任何副作用：
 * 最后一条消息是 AIMessage 且带 tool_calls → 去 tools 执行
 * 否则 → END，循环结束
 */
function routeAfterModel(state: ReactStateType): "tools" | typeof END {
  const lastMessage: BaseMessage | undefined = state.messages.at(-1);
  if (lastMessage && isAIMessage(lastMessage) && (lastMessage.tool_calls?.length ?? 0) > 0) {
    return "tools";
  }
  return END;
}

// ─────────────────────────────────────────────
// 4. 组装图
// ─────────────────────────────────────────────

const graphBuilder = new StateGraph(ReactState)
  .addNode("model", modelNode)
  .addNode("tools", toolsNode)
  .addEdge(START, "model")
  // model 之后的去向由路由函数决定
  .addConditionalEdges("model", routeAfterModel, {
    tools: "tools",
    [END]: END,
  })
  // tools 执行完固定回到 model，形成循环
  .addEdge("tools", "model");

/** 可复用的编译后图实例 */
export const reactGraph = graphBuilder.compile();

export { ReactState, modelNode, toolsNode, routeAfterModel };
