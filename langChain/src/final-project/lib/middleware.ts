/**
 * Middleware 组合
 *
 * 包裹顺序：createMiddlewareStack 返回数组，数组第一个是最外层，依次往里套。
 * 这里的三层顺序是：
 *   [toolErrorMiddleware, toolRetryMiddleware, summarizationMiddleware]
 *
 * 顺序的含义：
 *   外层先被调用、最后返回。所以：
 *     toolErrorMiddleware 在外层 → 它能看到"重试后的最终结果"，
 *       如果重试了 3 次还是失败，error middleware 看到的就是第三次的异常，
 *       它把这个异常转成 ToolMessage 回填给模型，重试就不算白跑。
 *     如果反过来（retry 在外、error 在内），retry 看到的就是
 *       error middleware 转好的 ToolMessage —— ToolMessage 是正常值，
 *       retry 不会重试，工具只跑一次。
 *
 * summarizationMiddleware 最内层 —— 它处理的是"消息列表太长"问题，
 * 只在 Agent 循环的边界触发，和工具调用错误 / 重试完全不在一个层面，
 * 放哪一层都行，放最内层只是为了"语义上最贴近 Agent 本身"。
 */
import { ToolMessage } from "@langchain/core/messages";
import { isGraphBubbleUp } from "@langchain/langgraph";
import { createMiddleware, summarizationMiddleware, toolRetryMiddleware } from "langchain";
import type { AppModel } from "./model";

/**
 * 自定义中间件：把工具抛出的异常转成模型可读的 ToolMessage。
 *
 * 为什么要自己写而不是靠 toolRetryMiddleware 吞异常：
 *   toolRetryMiddleware 只管"再试几次"；如果所有重试都失败，异常还是会往外抛，
 *   Agent 循环就此中断，客户端只会收到一个 error 事件，模型根本没机会告诉用户
 *   "search_knowledge_base 工具暂时不可用，要不先换个问题？"。
 *
 * wrapToolCall 的签名是 wrapToolCall(request, handler)，
 * handler() 就是实际的工具执行。这里 try/await/catch 包住它，
 * 成功时原样透传返回值，失败时转成带正确 tool_call_id 的 ToolMessage。
 *
 * isGraphBubbleUp 检查：
 *   LangGraph 框架内部用一种叫 "bubble up" 的异常实现中断、跳步等控制流。
 *   这种异常必须继续往上抛给框架处理，不能被我们的 catch 当成"工具错误"吞掉。
 */
const toolErrorMiddleware = createMiddleware({
  name: "tool-error-handler",
  wrapToolCall: async (request, handler) => {
    try {
      return await handler(request);
    } catch (error) {
      // 控制流异常：继续向上抛，让 LangGraph 按原有逻辑处理
      if (isGraphBubbleUp(error)) {
        throw error;
      }

      const toolName = request.toolCall.name;
      const reason = error instanceof Error ? error.message : String(error);

      console.error(`[tool-error-handler] ${toolName} 抛错，已转成 ToolMessage：${reason}`);

      // tool_call_id 是关键：模型发起工具调用时会给每个 tool_call 一个唯一 id，
      // ToolMessage 必须带上相同的 id，模型才能把"这次调用的结果"对号入座。
      // 如果 tool_call_id 缺失（理论上不会），退回空字符串也不会让 LangGraph 崩溃，
      // 只是模型可能对不上号 —— 但总比让整个 Agent 抛错好。
      return new ToolMessage({
        content: `工具 ${toolName} 调用失败：${reason}。请告知用户该工具暂时不可用。`,
        tool_call_id: request.toolCall.id ?? "",
        name: toolName,
        status: "error",
      });
    }
  },
});

/**
 * 组装完整中间件栈。
 * 每次调用都返回新数组（里面的三个 middleware 对象是模块级共享的，不会重复创建）。
 * 这样做是因为 createAgent 的 middleware 参数是数组值，不存引用。
 *
 * toolRetryMiddleware:
 *   maxRetries=2 表示失败后再试 2 次，总计 3 次尝试。
 *   initialDelayMs=300 表示第一次重试前等 300ms，给短暂网络抖动一点恢复时间。
 *
 * summarizationMiddleware:
 *   trigger: { messages: 20 } —— 当消息数（人类+AI+工具消息总和）达到 20 条时触发。
 *   keep: { messages: 6 } —— 把旧历史压缩成一段摘要，只保留最近 6 条原样。
 *   压缩过程本身也是一次模型调用（调用同一个 model 实例），所以 summarizationMiddleware
 *   依赖传入的 model 参数 —— 这也是为什么 createMiddlewareStack 需要 model。
 */
export function createMiddlewareStack(model: AppModel) {
  return [
    toolErrorMiddleware,
    toolRetryMiddleware({
      maxRetries: 2,
      initialDelayMs: 300,
    }),
    summarizationMiddleware({
      model,
      trigger: { messages: 20 },
      keep: { messages: 6 },
    }),
  ];
}
