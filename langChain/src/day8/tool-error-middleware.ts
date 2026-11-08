/**
 * Day 8 · 自定义 middleware：把工具异常转成模型可读的 ToolMessage
 *
 * middleware 的执行链路（简化版）：
 *
 *   模型发起 tool_calls
 *     → ToolNode 按顺序执行每个调用
 *     → 若有 middleware 提供 wrapToolCall，则由 middleware 包裹真正的执行函数
 *     → 工具结果（ToolMessage）回到消息列表，模型再生成回答
 *
 * 关键点：
 * - wrapToolCall 只负责“包裹”工具执行，handler(request) 才是真正执行工具；
 *   不调用 handler 就等于跳过工具，想「拦截」时可以用这种写法直接返回自定义结果；
 * - 捕获异常后必须返回带正确 tool_call_id 的 ToolMessage，
 *   这样模型才能在下一轮看到错误并如实告知用户；
 * - ToolMessage 的 name 要和工具名一致、status 设为 "error"，
 *   便于上层 UI 或日志区分「成功结果」和「错误回填」；
 * - 不能静默吞掉异常再假装成功，也不能把 HITL / LangGraph 的中断一并吃掉。
 *
 * 补充：ToolNode 在「没有 wrapToolCall」时有一套默认异常兜底；
 * 一旦检测到 wrapToolCall，默认兜底会让位，异常会直接抛进 middleware。
 * 换句话说，这里的 catch 是异常处理的唯一兜底点，漏掉就会让整个 Agent 崩溃。
 */
import { ToolMessage } from "@langchain/core/messages"; // ToolMessage：工具执行结果对应的消息类型
import { isGraphBubbleUp } from "@langchain/langgraph"; // 判断异常是否是「控制流」异常（如 interrupt），这类必须继续抛
import { createMiddleware } from "langchain"; // createMiddleware：声明一个 Agent middleware

export const toolErrorMiddleware = createMiddleware({
  // 导出一个可复用的 middleware 实例；参数就是 hook 的集合
  // name 会出现在中间件列表/调试信息里，起一个能一眼看懂的名字
  name: "tool-error-middleware", // middleware 名称
  // request.toolCall 包含 name / args / id；
  // handler(request) 是「执行工具并返回 ToolMessage」的函数
  wrapToolCall: async (request, handler) => {
    // 包裹工具调用：request 是本次调用，handler 是下游执行函数
    try {
      // 正常路径：把调用原样交给下游（可能是更内层的 middleware，也可能是真实工具）
      return await handler(request); // 下游返回 ToolMessage；异常会在这里抛出
    } catch (error) {
      // 捕获下游抛出的任何异常
      // 中断（interrupt）等控制流异常必须继续向上抛，否则 HITL 会失效。
      // isGraphBubbleUp 专门识别这类「不是错误、而是控制流」的异常。
      if (isGraphBubbleUp(error)) {
        // 如果是 LangGraph 的控制流异常
        throw error; // 原样抛回，让 HITL 中断继续生效
      }

      // 兼容非 Error 的抛出（例如 throw "xxx"），保证日志和回填文案都有内容
      const toolName = request.toolCall.name; // 当前工具名，用于日志和文案
      const reason = error instanceof Error ? error.message : String(error); // 取出可读的错误原因

      console.log(`  [tool-error-middleware] ${toolName} 抛错，已转成 ToolMessage：${reason}`); // 打日志：证明走了兜底分支

      // tool_call_id 必须与模型发起的调用一致，否则模型无法把结果对上号。
      // 这里保留了兜底 ""，正常流程下 id 一定存在。
      return new ToolMessage({
        // 构造一条「错误结果」消息
        content: `工具 ${toolName} 调用失败：${reason}。请告知用户该工具暂时不可用。`, // 给模型看的错误文案（要求它如实告知用户）
        tool_call_id: request.toolCall.id ?? "", // 与原调用一一对应；缺 id 时用空串兜底
        name: toolName, // 标记是哪个工具返回的
        status: "error", // 标记为错误结果，便于 UI / 日志区分
      });
    }
  },
});
