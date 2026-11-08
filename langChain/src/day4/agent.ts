/**
 * Day 4：用 createAgent 搭一个能自主调用工具的 Agent。
 * 运行：npm run day4（需要 Node 20+）
 */
import { createAgent } from "langchain"; // 导入 Agent 工厂函数，一行创建 ReAct Agent
import { // 从 core/messages 导入消息类
  AIMessage, // 模型产出的消息，可能携带 tool_calls
  HumanMessage, // 用户输入消息
  ToolMessage, // 本地工具执行后回填给模型的结果消息
  type BaseMessage, // 所有消息的基类，这里只作为类型使用
} from "@langchain/core/messages"; // 消息模块导入结束
import { z } from "zod"; // 用 Zod 定义结构化 schema
import { createModel, describeError, loadEnv } from "../shared/model.js"; // 共享的模型创建/环境变量/错误翻译
import { tools } from "../day3/tools.js"; // 直接复用 Day 3 的“时间 + 计算 + 检索”工具

const DEFAULT_QUESTION = "现在上海几点？再算一下 42 * 17"; // 无参数时的默认问题，覆盖时间与计算两个工具

/**
 * Agent 的系统提示：约束行为。
 * 注意：模板字符串内部的每一行都属于字符串内容，不能写 // 注释，否则会改变提示词。
 */
const SYSTEM_PROMPT = `你是一个乐于助人的中文 AI 助手，请遵守以下规则：
1. 用中文回答，简洁准确。
2. 先判断问题是否需要工具：需要实时信息或精确计算时，必须调用工具，不要凭空编造。
3. 工具返回的结果要转述成自然语言，不要原样粘贴 JSON 或原始字符串。
4. 不知道答案时直接说“不知道”，不要猜测。`;

/**
 * 最终答复的 schema。
 * 当前 provider 不支持原生 JSON Schema 输出时，LangChain 会把它转成“结构化输出工具”。
 */
const AnswerSchema = z // 从 Zod 开始构建 schema
  .object({ // 声明一个对象结构
    answer: z.string().describe("对用户问题的最终中文回答"), // 最终回答：字符串
    usedTools: z.array(z.string()).describe("本轮实际调用过的工具名；没有调用则为空数组"), // 调用过的工具名列表
    confidence: z.enum(["low", "medium", "high"]).describe("对该答案的置信度"), // 置信度只能是三个枚举值之一
  }) // 对象字段声明结束
  .describe("提交最终答复的结构化输出工具。信息足够时调用本工具提交结果，不要直接输出纯文本。"); // 这段描述会变成工具描述，引导模型收尾时调用

/**
 * 从消息中抽取纯文本。
 * v1 的 content 可能是 string，也可能是 ContentBlock[]（例如 text、image_url 等块）。
 */
function textOf(message: BaseMessage): string { // 接收任意消息，返回其中的文本
  if (typeof message.content === "string") { // 情况一：content 本身就是字符串
    return message.content; // 直接返回
  } // 字符串分支结束

  let text = ""; // 用于累加文本块
  for (const block of message.content) { // 情况二：遍历内容块数组
    if (block.type === "text" && typeof block.text === "string") { // 只处理 text 类型且带 text 字段的块
      text += block.text; // 把文本块拼接起来
    } // 单个块的判断结束
  } // 遍历结束
  return text; // 返回拼接后的纯文本
} // textOf 结束

/**
 * 把多行文本压成单行并截断。
 */
function truncate(text: string, max = 200): string { // 默认最多保留 200 个字符
  const singleLine = text.replace(/\s+/g, " ").trim(); // 连续空白替换成单个空格，并去掉首尾空白
  return singleLine.length > max ? `${singleLine.slice(0, max)}…` : singleLine; // 超长则截断并加省略号，否则原样返回
} // truncate 结束

/**
 * 打印工具调用轨迹：
 * HumanMessage → AIMessage(tool_calls) → ToolMessage → … → AIMessage(最终文本)
 */
function printToolTrace(messages: BaseMessage[]): void { // 接收本轮完整消息数组
  let index = 0; // 调用序号，从 1 开始计数

  for (const message of messages) { // 按时间顺序遍历消息
    if (AIMessage.isInstance(message)) { // 判断是不是 AIMessage（类型守卫）
      for (const call of message.tool_calls ?? []) { // 遍历模型要求的工具调用；没有则空数组
        index += 1; // 序号加一
        console.log(`  [${index}] 调用 ${call.name}(${JSON.stringify(call.args)})`); // 打印工具名和参数
      } // 单个 AIMessage 的调用遍历结束
      continue; // 处理完 AI 消息就进入下一条
    } // AIMessage 分支结束

    if (ToolMessage.isInstance(message)) { // 判断是不是工具结果消息
      const label = message.name ?? "unknown"; // 获取工具名，缺失时用 unknown
      console.log(`      ← ${label} 返回：${truncate(textOf(message))}`); // 打印工具返回结果（截断）
    } // ToolMessage 分支结束
  } // 消息遍历结束

  if (index === 0) { // 一次工具调用都没有
    console.log("  （本轮没有调用工具）"); // 明确提示，避免看起来像漏打印
  } // 空轨迹判断结束
} // printToolTrace 结束

async function main(): Promise<void> { // 主流程入口
  loadEnv(); // 读取 .env，必须在创建模型之前

  const cliQuestion = process.argv.slice(2).join(" ").trim(); // 把命令行参数拼成一个字符串
  const question = cliQuestion || DEFAULT_QUESTION; // 有自定义问题就用它，否则用默认问题

  console.log(`问题：${question}`); // 先打印本次的问题

  const model = await createModel(); // 创建聊天模型实例（内部会校验环境变量）

  // ---------- 1. 基础 Agent：invoke + systemPrompt ----------
  console.log("\n=== 基础 Agent（createAgent + systemPrompt）==="); // 打印小节标题

  const agent = createAgent({ // 创建 Agent 实例
    model, // 使用的模型
    tools, // 可用工具，框架内部自动 bindTools
    systemPrompt: SYSTEM_PROMPT, // 行为约束
  }); // createAgent 调用结束

  const result = await agent.invoke({ // 一次性执行，等全部完成后返回
    messages: [new HumanMessage(question)], // 输入必须是状态对象，messages 为消息数组
  }); // invoke 调用结束

  printToolTrace(result.messages); // 打印本轮的调用轨迹

  const toolCallCount = result.messages.reduce((total, message) => { // 统计工具调用次数
    if (!AIMessage.isInstance(message)) return total; // 非 AI 消息不计数
    return total + (message.tool_calls?.length ?? 0); // 累加每条 AI 消息里的 tool_calls 数量
  }, 0); // 初始值为 0
  console.log(`本轮工具调用次数：${toolCallCount}`); // 打印统计结果

  const finalAnswer = [...result.messages] // 复制一份消息数组，避免改动原数组
    .reverse() // 从后往前找
    .find( // 找到第一条符合条件的消息
      (message): message is AIMessage => // 类型守卫：命中后收窄为 AIMessage
        AIMessage.isInstance(message) && (message.tool_calls?.length ?? 0) === 0, // 条件：是 AI 消息且不再请求工具
    ); // find 结束

  console.log(`\n最终回答：${finalAnswer ? textOf(finalAnswer) : "（没有拿到自然语言回答）"}`); // 打印最终回答或兜底提示

  // ---------- 2. 流式输出：streamMode = "messages" ----------
  console.log('\n=== 流式输出（streamMode: "messages"）==='); // 打印小节标题
  process.stdout.write("AI: "); // 先输出前缀且不换行

  const messageStream = await agent.stream( // 以流的方式执行
    { messages: [new HumanMessage(question)] }, // 第一个参数：输入状态
    { streamMode: "messages" }, // 第二个参数：配置，模式放在 config 里
  ); // stream 调用结束

  for await (const [message] of messageStream) { // 逐项消费流；每项是 [消息分片, metadata]
    if (!AIMessage.isInstance(message)) continue; // 只处理 AI 分片，跳过工具消息
    const text = textOf(message); // 提取分片里的文本
    if (!text) continue; // 空文本（例如纯 tool_calls 分片）跳过
    process.stdout.write(text); // 立即写出增量文本
  } // 流消费结束
  process.stdout.write("\n"); // 流结束后换行

  // ---------- 3. 流式输出：streamMode = "updates" ----------
  console.log('\n=== 流式输出（streamMode: "updates"）==='); // 打印小节标题

  const updateStream = await agent.stream( // 以节点级更新流式执行
    { messages: [new HumanMessage(question)] }, // 输入状态
    { streamMode: "updates" }, // 每个节点完成时产出一项
  ); // stream 调用结束

  for await (const update of updateStream) { // 逐项消费；每项是 { 节点名: 更新内容 }
    for (const [node, value] of Object.entries(update)) { // 遍历节点名与对应的更新
      const data = value as { messages?: BaseMessage[] }; // 类型断言：更新里通常有 messages
      const messages = data.messages ?? []; // 没有消息时用空数组避免报错

      if (messages.length === 0) { // 该节点没有产生消息
        console.log(`- 节点 ${node}（无消息更新）`); // 仍然打印节点名
        continue; // 继续下一个节点
      } // 空消息判断结束

      console.log(`- 节点 ${node}`); // 打印节点名
      for (const message of messages) { // 遍历该节点新增的消息
        if (AIMessage.isInstance(message)) { // 模型节点的输出
          for (const call of message.tool_calls ?? []) { // 可能一次请求多个工具
            console.log(`    发起工具调用：${call.name}(${JSON.stringify(call.args)})`); // 打印调用名与参数
          } // 工具调用遍历结束
          const text = textOf(message); // 提取该消息的文本
          if (text) { // 有文本才打印
            console.log(`    文本：${truncate(text)}`); // 打印截断后的文本
          } // 文本判断结束
        } else if (ToolMessage.isInstance(message)) { // 工具节点的输出
          console.log( // 打印工具返回
            `    工具返回（${message.name ?? "unknown"}）：${truncate(textOf(message))}`, // 工具名 + 截断内容
          ); // console.log 结束
        } // 消息类型分支结束
      } // 消息遍历结束
    } // 节点遍历结束
  } // 流消费结束

  // ---------- 4. responseFormat：结构化输出 ----------
  console.log("\n=== responseFormat 结构化输出 ==="); // 打印小节标题

  const structuredAgent = createAgent({ // 创建带结构化输出的 Agent
    model, // 使用的模型
    tools, // 仍需要工具来查时间、做计算
    systemPrompt: SYSTEM_PROMPT, // 相同的行为约束
    responseFormat: AnswerSchema, // 关键：最终结果按 schema 提交
  }); // createAgent 调用结束

  const structuredResult = await structuredAgent.invoke({ // 执行并等待完整结果
    messages: [new HumanMessage(question)], // 输入消息
  }); // invoke 调用结束

  console.log(JSON.stringify(structuredResult.structuredResponse, null, 2)); // 打印结构化结果，缩进 2 空格
} // main 结束

try { // 顶层统一捕获异常
  await main(); // 执行主流程
} catch (error) { // 捕获任意异常
  console.error(describeError(error)); // 翻译成中文错误提示
  process.exit(1); // 以非 0 状态退出，便于脚本/CI 判断失败
} // try/catch 结束
