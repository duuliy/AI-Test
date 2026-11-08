/**
 * 结构化路由
 *
 * 为什么在 Agent 之前加一层路由：
 *   三个路由（knowledge / time / general）需要不同的工具集合和不同的系统提示词。
 *   knowledge 路由放 search_knowledge_base，time 和 general 不放 ——
 *   否则模型遇到一个闲聊问题也可能硬调检索工具，浪费一次 embedding + 向量库查询。
 *   路由本身不用 LangGraph StateGraph，就一个 withStructuredOutput 调用搞定。
 *
 * 路由结果**绝不改写用户原问题**，只选择"这条消息走哪条支路"。
 */
import { HumanMessage, SystemMessage, type BaseMessage } from "@langchain/core/messages";
import { z } from "zod";
import { getModel } from "./model";

/**
 * RouteSchema 同时约束模型的输出形状和给它的"使用说明"。
 * z.enum 让模型在三个值中选一个，.describe() 的内容会作为 functionCalling 的 description，
 * 模型读了才知道三种路由分别对应什么情况。
 */
export const RouteSchema = z.object({
  route: z
    .enum(["knowledge", "time", "general"])
    .describe(
      "knowledge：询问文档内容、概念、流程、原理；time：询问当前时间、日期、时区；general：闲聊或其他问题",
    ),
  reason: z.string().describe("用一句简短的中文说明为什么选择这个路由"),
});

export type Route = z.infer<typeof RouteSchema>["route"];
export type RouteDecision = z.infer<typeof RouteSchema>;

/** 路由器专属的系统提示词；和 Agent 的系统提示词完全独立 */
const ROUTER_SYSTEM_PROMPT = [
  "你是一个问题路由器。根据用户最后一句话选择最合适的 route。",
  "规则：",
  "1. 问文档、概念、流程、原理（例如 LangChain、RAG、Agent、middleware）时选 knowledge。",
  "2. 问现在几点、今天几号、某个时区的时间时选 time。",
  "3. 闲聊、寒暄、与上述主题无关的问题选 general。",
  "只输出 route 和 reason，不要改写用户问题。",
].join("\n");

/**
 * 自己声明 Runner 接口，而不是直接用 LangChain Runnable。
 * 只暴露 invoke(messages) 一个方法，降低文件间的类型耦合 ——
 * withStructuredOutput 返回的 Runnable 类型很复杂，但这里只用到 invoke。
 */
interface Runner {
  invoke(messages: BaseMessage[]): Promise<RouteDecision>;
}

/** 和 modelPromise / vectorStorePromise 同模式：缓存 Promise，失败后清缓存 */
let runnerPromise: Promise<Runner> | undefined;

function getRunner(): Promise<Runner> {
  if (!runnerPromise) {
    runnerPromise = getModel()
      .then((model) => {
        // method: "functionCalling" 让模型用 function call 返回结构化结果，
        // 而不是试图在 JSON code block 里写。
        // 智谱 GLM 等兼容端点对 json_schema 支持不完整，functionCalling 更稳。
        const runner: Runner = model.withStructuredOutput(RouteSchema, {
          name: "route_question",
          method: "functionCalling",
        });
        return runner;
      })
      .catch((error: unknown) => {
        runnerPromise = undefined;
        throw error;
      });
  }
  return runnerPromise;
}

/**
 * 路由入口。
 * 兜底策略：路由失败（模型不可用 / 输出不符合 schema）时，
 * 直接降级到 knowledge 路由，让整条链路继续走而不是给用户返回 500。
 * 原因：knowledge 路由"放多了工具"比"放少了工具"更安全 ——
 * 放多了模型最多多调一次检索；放少了它就答不了知识库问题。
 */
export async function routeQuestion(message: string): Promise<RouteDecision> {
  try {
    const runner = await getRunner();
    const result = await runner.invoke([
      new SystemMessage(ROUTER_SYSTEM_PROMPT),
      new HumanMessage(message),
    ]);

    // withStructuredOutput 在 schema 不匹配时会抛错，这里额外做 null check 是防御模型返回空对象的情况
    if (!result) {
      throw new Error("模型返回了空的路由结果");
    }
    return result;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    console.error(`[router] 结构化路由失败，回退到 knowledge：${reason}`);
    return { route: "knowledge", reason: "路由失败，按知识库问题处理" };
  }
}
