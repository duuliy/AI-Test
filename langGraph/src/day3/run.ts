/**
 * Day 3: 演示脚本
 *
 * A. 不调工具：模型直接回答，路由返回 END
 * B. 单工具：get_current_time
 * C. 多工具：时间 + 计算，可能出现多轮 model → tools → model
 * D. 工具异常：broken_lookup 抛错，被转成 ToolMessage，图正常结束
 * E. 循环保护：recursionLimit 限制步数，捕获 GraphRecursionError
 */

import { HumanMessage, ToolMessage, isAIMessage } from "@langchain/core/messages";
import type { BaseMessage } from "@langchain/core/messages";
import { GraphRecursionError } from "@langchain/langgraph";
import { reactGraph } from "./react-graph.js";
import { describeError, extractText } from "./model.js";

const QUESTION_A = "用一句话解释什么是图编排";
const QUESTION_B = "现在上海几点？";
const QUESTION_C = "现在几点？再算一下 37 * 19";
const QUESTION_D = "帮我查一下 broken lookup 里的内容";

/** 从消息历史里统计 tool_calls，不自己维护计数器 */
function collectToolCalls(messages: BaseMessage[]) {
  return messages.filter(isAIMessage).flatMap((message) => message.tool_calls ?? []);
}

/** 打印消息历史里的工具请求与工具结果 */
function printHistory(messages: BaseMessage[]): void {
  for (const message of messages) {
    if (isAIMessage(message)) {
      for (const toolCall of message.tool_calls ?? []) {
        console.log(
          `  [模型请求] ${toolCall.name}  参数: ${JSON.stringify(toolCall.args)}  调用 id: ${toolCall.id}`
        );
      }
      const text = extractText(message);
      if (text) console.log(`  [模型回答] ${text}`);
    } else if (ToolMessage.isInstance(message)) {
      console.log(
        `  [工具结果] ${message.name ?? "unknown"}  调用 id: ${message.tool_call_id}  内容: ${extractText(message)}`
      );
    }
  }
}

/** 跑一个场景并打印结果 */
async function runSection(
  title: string,
  question: string,
  config?: { recursionLimit: number }
): Promise<void> {
  console.log(`\n--- ${title} ---`);
  console.log(`问题: ${question}`);

  const result = await reactGraph.invoke(
    { messages: [new HumanMessage(question)] },
    config
  );

  const messages = result.messages;
  printHistory(messages);

  const lastMessage = messages.at(-1);
  console.log(`最终回答: ${lastMessage ? extractText(lastMessage) : "（空）"}`);

  const toolCalls = collectToolCalls(messages);
  console.log(
    `tool_calls 总数: ${toolCalls.length}${
      toolCalls.length > 0 ? `（${toolCalls.map((call) => call.name).join(", ")}）` : ""
    }`
  );
  console.log(`model 节点执行轮数: ${result.rounds}`);
}

async function runDemo() {
  console.log("=".repeat(60));
  console.log("Day 3: 条件边、循环与工具协议");
  console.log("=".repeat(60));

  // A. 不调工具：路由函数返回 END，循环不启动
  await runSection("A. 不调工具", QUESTION_A);

  // B. 单工具
  await runSection("B. 单工具", QUESTION_B);

  // C. 多工具：可能一次返回多个 tool_calls，也可能分多轮
  await runSection("C. 多工具", QUESTION_C);

  // D. 工具异常：broken_lookup 抛出 Error("检索服务不可用")
  await runSection("D. 工具异常", QUESTION_D);

  // E. 循环保护：故意把 recursionLimit 调小
  console.log(`\n--- E. 循环保护（recursionLimit = 4） ---`);
  console.log(`问题: ${QUESTION_C}`);
  console.log("注意：这是故意触发的演示，不是代码 bug");
  try {
    await runSection("E. 执行结果", QUESTION_C, { recursionLimit: 4 });
    console.log("本次没有触发递归上限：模型在 4 步内就完成了。");
  } catch (error) {
    if (error instanceof GraphRecursionError) {
      console.log("捕获到 GraphRecursionError。");
      console.log(
        "中文提示：图已达到 recursionLimit=4，被框架强制停止。默认上限是 25；" +
          "可以在 invoke 的第二个参数传入 { recursionLimit: N } 调整，" +
          "或者检查路由函数是否在不需要工具时正确返回 END。"
      );
      console.log(`原始错误信息: ${error.message}`);
    } else {
      throw error;
    }
  }

  console.log("\n" + "=".repeat(60));
  console.log("Day 3 完成");
  console.log("=".repeat(60));
}

runDemo().catch((error) => {
  console.error("\n运行出错：", describeError(error));
  if (describeError(error).includes("缺少环境变量")) {
    console.error("请把 .env.example 复制为 .env，并填入 OPENAI_API_KEY / OPENAI_BASE_URL / OPENAI_MODEL");
  }
  process.exit(1);
});
