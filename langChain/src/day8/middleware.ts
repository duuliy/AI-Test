/**
 * Day 8 · Middleware 综合演示
 *
 * 一个 Agent 同时挂 4 个功能 middleware + 1 个探针，按 A/B/C/D 四个场景分别观察效果：
 *   A. toolRetryMiddleware        —— flaky_search 失败自动重试
 *   B. humanInTheLoopMiddleware   —— delete_note 执行前暂停，等待人工 approve / reject
 *   C. 自定义 wrapToolCall        —— broken_weather 抛错被转成可读 ToolMessage
 *   D. summarizationMiddleware    —— 对话变长后自动压缩为摘要 + 最近消息
 *   探针 probeMiddleware          —— 不改行为，只把每个 hook 的调用时机打进日志
 *
 * 阅读顺序（建议从下往上先看 main，再回看辅助函数）：
 *   1. 先看 main() 里的四段 A/B/C/D，了解「要观察什么现象」；
 *   2. 再看 createAgent 的配置，知道 middleware 是怎么挂上去的；
 *   3. 最后回看顶部 4 个辅助函数，它们只是把结果打印得更可读。
 */
import { AIMessage, HumanMessage, ToolMessage, type BaseMessage } from "@langchain/core/messages"; // 消息类型：AI/用户/工具消息，以及基类
import { Command, MemorySaver } from "@langchain/langgraph"; // Command 用于 HITL 恢复；MemorySaver 用于保存 thread 状态
import {
  // 从 langchain 主包导入 Agent 与四个 middleware
  createAgent, // 创建 ReAct Agent（内部就是 LangGraph 图）
  createMiddleware, // 声明自定义 middleware（探针就用它）
  humanInTheLoopMiddleware, // 工具执行前暂停，等待人工审批
  summarizationMiddleware, // 历史过长时自动摘要压缩
  toolRetryMiddleware, // 工具失败自动重试
  type HITLRequest, // 中断 value 的类型：包含 actionRequests / reviewConfigs
  type HITLResponse, // resume 时 decisions 的类型：approve / reject / edit
  type Interrupt, // 中断对象类型：{ id, value }
} from "langchain";
import { createChatModel, describeError, loadEnv } from "./model.js"; // 模型创建、错误翻译、.env 读取
import { tools } from "./tools.js"; // 四个演示工具
import { toolErrorMiddleware } from "./tool-error-middleware.js"; // 自定义错误兜底 middleware

/**
 * 系统提示词（会被 createAgent 转成 SystemMessage，不进入 state.messages）。
 *
 * 第 3 条是 HITL Demo 能跑通的关键：模型天生谨慎，遇到「删除」会先反问用户
 * 「你确定吗？」，从而根本不调用 delete_note，中断也就无从触发。
 * 明确告诉它「审批由系统负责」，它才会直接发起工具调用，把决策权交给 middleware。
 */
const SYSTEM_PROMPT = `你是一个中文助手。
- 回答简洁、准确。
- 需要实时信息或执行操作时，优先调用工具，不要凭空编造。
- 用户要求删除笔记时，直接调用 delete_note，审批由系统负责，不要自行向用户二次确认。
- 如果工具返回错误，如实告知用户该工具暂时不可用，不要假装成功。`;

/**
 * 从消息中取出纯文本。
 *
 * content 有两种形态：普通字符串，或 ContentBlock[]（多模态/多段文本）。
 * 这里只拼接 type === "text" 的块，跳过图片、工具参数等非文本块，
 * 避免把对象直接 String() 出来变成 [object Object]。
 */
function textOf(message: BaseMessage): string {
  // 参数 message：任意一条 LangChain 消息
  if (typeof message.content === "string") {
    // 最常见情况：content 就是字符串
    return message.content; // 直接返回，省掉遍历
  }

  let text = ""; // 多段内容时用累加器拼文本
  for (const block of message.content) {
    // 逐块检查 ContentBlock
    if (block.type === "text" && typeof block.text === "string") {
      // 只处理文本块，且 text 字段确实是字符串
      text += block.text; // 把文本块拼到结果里
    }
  }
  return text; // 没有任何文本块时返回空字符串
}

/**
 * 取最后一条不带 tool_calls 的 AI 消息文本，作为给用户的最终回答。
 *
 * 为什么要跳过带 tool_calls 的 AIMessage？
 * Agent 一轮里可能出现「AI(tool_calls) → Tool → AI(tool_calls) → Tool → AI(text)」，
 * 前面的 AI 消息内容通常是空字符串，只有最后一条才是真正的自然语言回答。
 * 从后往前找，找到第一条「有文本且不发起工具调用」的就返回。
 */
function lastAIText(messages: BaseMessage[]): string {
  // 参数 messages：该 thread 的完整消息列表
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    // 从最后一条往前遍历（倒序：最新消息优先）
    const message = messages[index]; // 取出当前消息（strict 模式下可能是 undefined）
    if (message && AIMessage.isInstance(message) && (message.tool_calls?.length ?? 0) === 0) {
      // 三个条件同时满足：消息存在 + 是 AIMessage + 没有发起工具调用
      return textOf(message) || "（空文本）"; // 返回文本；空字符串时给个占位符
    }
  }
  return "（本轮没有 AI 文本）"; // 全都没有命中时的兜底文案
}

/**
 * 打印本轮的工具调用与返回轨迹。
 *
 * 这是观察 middleware 效果的主要窗口：
 * - 看到几次「调用 flaky_search」→ retry 到底重试了几次；
 * - 看到 status=error 的 ToolMessage → 错误兜底 middleware 生效了；
 * - HITL 场景里 approve 之后才会出现 delete_note 的 ToolMessage。
 * 注意 status 是 ToolMessage 自带字段，默认 undefined 表示成功。
 */
function printToolTrace(messages: BaseMessage[]): void {
  // 参数 messages：要打印的消息列表
  let calls = 0; // 统计本轮工具调用次数，用于「没有调用」的提示

  for (const message of messages) {
    // 遍历所有消息
    if (AIMessage.isInstance(message)) {
      // 先处理 AI 消息：它的 tool_calls 才是「发起了调用」的证据
      for (const call of message.tool_calls ?? []) {
        // 一条 AI 消息可能同时发起多个工具调用
        calls += 1; // 计数 +1
        console.log(`  调用 ${call.name}(${JSON.stringify(call.args)})`); // 打印工具名和参数
      }
      continue; // AI 消息处理完就跳到下一条，避免下面再判断 ToolMessage
    }

    if (ToolMessage.isInstance(message)) {
      // ToolMessage 是「工具执行结果」
      const status = message.status ?? "success"; // 没设置 status 就视为成功
      console.log(`  工具 ${message.name ?? "unknown"} 返回（status=${status}）：${textOf(message)}`); // 打印结果
    }
  }

  if (calls === 0) {
    // 整轮没出现过 tool_calls
    console.log("  （本轮没有调用工具）"); // 明确提示，避免误以为打印漏了
  }
}

/**
 * 摘要 middleware 会把旧消息替换成一条带 lc_source 标记的 HumanMessage。
 *
 * 摘要不是「追加」而是「替换」：先对旧消息发 RemoveMessage，
 * 再插入一条 additional_kwargs.lc_source === "summarization" 的 HumanMessage，
 * 后面接上保留下来的最近消息。所以判断是否压缩过，看这个标记最可靠，
 * 光看消息数会因为反复对话而忽高忽低，容易误判。
 */
function hasSummaryMessage(messages: BaseMessage[]): boolean {
  // 参数 messages：某个 thread 的完整消息列表
  return messages.some((message) => message.additional_kwargs?.lc_source === "summarization"); // 存在任意一条摘要消息即返回 true
}

/**
 * 探针 middleware：不改变任何行为，只把每个 hook 被调用的时机打进日志。
 *
 * 用途：把「middleware 什么时候跑」从隐含变成可见。
 * - beforeAgent / afterAgent：整个 invoke 的开头和结尾各一次；
 * - beforeModel / afterModel：每次「调模型」的前后各一次；
 * - wrapModelCall：包住真正的模型请求，能看到进入/退出；
 * - wrapToolCall：包住每一次工具执行，重试时会反复进入。
 *
 * 它被放在 retry 的内侧（见下面 middleware 数组），所以：
 * - flaky_search 每次重试都会重新进入探针，日志能数出尝试次数；
 * - broken_weather 抛错时只有「进入」没有「退出」，说明异常穿透了探针。
 */
const probeMiddleware = createMiddleware({
  // 声明探针 middleware
  name: "probe", // 名称会出现在日志和 graph 节点名里
  beforeAgent: (state) => {
    // 整个 invoke 开始（每次 invoke 只跑一次）
    console.log(`[probe] beforeAgent · 消息数=${state.messages.length}`); // 打印当前消息数
  },
  beforeModel: (state) => {
    // 每次调用模型之前（摘要就是在这个阶段改 messages）
    console.log(`[probe] beforeModel · 消息数=${state.messages.length}`); // 打印压缩后的消息数
  },
  wrapModelCall: async (request, handler) => {
    // 包住真正的模型请求：进入时打印输入规模
    console.log(`[probe] wrapModelCall 进入 · 消息数=${request.state.messages.length}`); // 模型即将看到的消息数
    const response = await handler(request); // 调用下游（真正请求模型）
    // 退出时打印模型这轮发起了几个工具调用
    const toolCount = AIMessage.isInstance(response) ? (response.tool_calls?.length ?? 0) : 0; // Command 等返回类型按 0 处理
    console.log(`[probe] wrapModelCall 退出 · tool_calls=${toolCount}`); // 打印工具调用数量
    return response; // 原样返回，不做任何修改
  },
  afterModel: (state) => {
    // 模型返回之后（HITL 就是在这个阶段决定要不要 interrupt）
    console.log(`[probe] afterModel · 消息数=${state.messages.length}`); // 打印本轮末尾消息数
  },
  wrapToolCall: async (request, handler) => {
    // 包住每一次工具执行：进入时打印工具名
    console.log(`[probe] wrapToolCall 进入 · ${request.toolCall.name}`); // 重试时这一行会重复出现
    const result = await handler(request); // 调用下游（可能是更内层 middleware，也可能是真实工具）
    console.log(`[probe] wrapToolCall 退出 · ${request.toolCall.name}`); // 正常返回才会打印；抛错时不会出现
    return result; // 原样返回工具结果
  },
  afterAgent: (state) => {
    // 整个 invoke 结束（最终回答已经写进 messages）
    console.log(`[probe] afterAgent · 消息数=${state.messages.length}`); // 打印收尾时的消息数
  },
});

async function main(): Promise<void> {
  // 入口函数：所有演示都按顺序在这里跑
  loadEnv(); // 先把 .env 读进 process.env（必须在创建模型之前）
  const model = await createChatModel(); // 创建聊天模型（initChatModel 是异步的）

  console.log("LangChain.js Day 8 · Middleware"); // 打印标题
  console.log(`模型：${process.env.OPENAI_MODEL ?? "(未设置)"}\n`); // 打印当前使用的模型名

  /*
   * HITL 和摘要都依赖「跨 invoke 保存状态」，所以必须挂 checkpointer：
   * - HITL 中断后，第二次 invoke 要能从同一个 thread 的断点继续执行；
   * - 摘要需要看到完整历史，才能判断消息数是否达到阈值。
   * 这里用内存版 MemorySaver（进程退出即清空）；生产环境应换成持久化 saver。
   */
  const checkpointer = new MemorySaver(); // 内存版状态存储：按 thread_id 保存消息

  /**
   * middleware 数组的包裹顺序很重要：
   * LangChain 从数组第一个开始，把每个 wrapToolCall 依次包在外层（第一个 = 最外层）。
   *
   * 因此这里把「错误兜底」放在 retry 之前：
   *   toolErrorMiddleware(  toolRetryMiddleware(  baseHandler  )  )
   *
   * 如果按提示词初稿把 retry 放最外层，调用链会变成
   *   toolRetryMiddleware(  toolErrorMiddleware(  baseHandler  )  )
   * 工具抛错时内层错误 middleware 先把它转换成 ToolMessage，
   * retry 看到的是「调用成功」，于是只尝试 1 次就结束，重试完全失效。
   * 所以必须让 retry 在内层，才能捕获到真正的异常并重试。
   *
   * humanInTheLoopMiddleware 默认是 batched 模式，走 afterModel（在工具执行前暂停），
   * 不参与 wrapToolCall 包裹链，放在哪里都不影响重试。
   * summarizationMiddleware 走 beforeModel，同样与工具包裹链无关。
   */
  const middleware = [
    // middleware 数组：顺序 = 包裹顺序（第一个在最外层）
    toolErrorMiddleware, // 第 1 层（最外层）：异常兜底，把 throw 转成 ToolMessage
    toolRetryMiddleware({
      // 第 2 层：只对指定工具重试
      maxRetries: 2, // 失败后再试 2 次，总尝试 3 次
      initialDelayMs: 300, // 第一次重试前等待 300ms
      backoffFactor: 1, // 退避倍率 1：每次等待时间不变（300ms → 300ms）
      tools: ["flaky_search"], // 白名单：只重试 flaky_search，其它工具异常直接往上抛
    }),
    probeMiddleware, // 观测层（不计入功能分层）：只打日志，不改行为；放在 retry 内侧，每次重试都会重新进入
    humanInTheLoopMiddleware({
      // 第 3 层：工具执行前人工审批（batched 模式走 afterModel）
      interruptOn: {
        // interruptOn 的 key 是工具名
        delete_note: {
          // delete_note 需要审批
          allowedDecisions: ["approve", "reject"], // 允许的决定：通过 / 拒绝（还支持 "edit"）
          description: "删除笔记需要人工确认", // 展示在中断信息里，供审批 UI 使用
        },
      },
    }),
    summarizationMiddleware({
      // 第 4 层：历史压缩（beforeModel，在调模型前执行）
      model, // 摘要本身也是一次模型调用，复用同一个实例
      trigger: { messages: 8 }, // 消息数 ≥ 8 时触发压缩
      keep: { messages: 4 }, // 压缩后保留最近 4 条原文
    }),
  ];

  const agent = createAgent({
    // 用配置创建 Agent（返回的对象里带 invoke / graph 等能力）
    model, // 主模型
    tools, // 四个工具
    systemPrompt: SYSTEM_PROMPT, // 系统提示词（不进 state.messages）
    middleware, // 上面这一组 middleware
    checkpointer, // 状态存储：HITL 恢复、摘要计数都依赖它
  });

  /**
   * 读取某个 thread 当前 state 里的消息数量和是否含摘要消息。
   *
   * agent.graph.getState 会从 checkpointer 里取该 thread 的最新快照，
   * 这是「外部观察 Agent 内部状态」的唯一正确方式；
   * 不要用 invoke 的返回值直接推断，因为 invoke 返回的是本轮结束时的 state，
   * 而摘要发生在 beforeModel，期间的变化未必都体现在最终返回里。
   */
  async function readState(threadId: string): Promise<{ count: number; summarized: boolean }> {
    // 参数 threadId：会话线程标识
    const snapshot = await agent.graph.getState({ configurable: { thread_id: threadId } }); // 取该 thread 的最新快照
    const messages = snapshot.values.messages; // 快照里的消息列表（类型可能是 undefined）
    const list: BaseMessage[] = Array.isArray(messages) ? messages : []; // 兜底成数组，避免下标访问报错
    return { count: list.length, summarized: hasSummaryMessage(list) }; // 返回消息数 + 是否压缩过
  }

  /* ------------------------------------------------------------------------ */
  /* A. 重试                                                                    */
  /* ------------------------------------------------------------------------ */
  /*
   * 观察点：flaky_search 的日志应出现 3 行（第 1、2 次抛错，第 3 次成功）。
   * maxRetries 是「额外重试次数」，所以总尝试次数 = 1 + maxRetries = 3。
   * initialDelayMs + backoffFactor 控制退避：这里每次间隔固定 300ms。
   * tools 白名单保证只有 flaky_search 会被重试，broken_weather 不受影响，
   * 否则 C 场景的异常会被 retry 包装成英文报错，掩盖自定义 middleware 的效果。
   */
  console.log("=== A. 工具失败自动重试（toolRetryMiddleware）==="); // 场景标题
  console.log("用户：帮我搜索 flaky 数据"); // 模拟用户输入

  const retryConfig = { configurable: { thread_id: "day8-retry" } }; // A 场景专用 thread（与 B/C/D 隔离）
  const retryResult = await agent.invoke(
    // 跑一轮 Agent，直到模型给出最终回答
    { messages: [new HumanMessage("帮我搜索 flaky 数据")] }, // 输入：一条用户消息
    retryConfig, // 第二个参数：thread 配置
  );

  printToolTrace(retryResult.messages); // 打印调用轨迹：应能看到 3 次 flaky_search
  console.log(`最终回答：${lastAIText(retryResult.messages)}\n`); // 打印模型最终回答（\n 用于空行分隔场景）

  /* ------------------------------------------------------------------------ */
  /* B. Human-in-the-loop：approve                                              */
  /* ------------------------------------------------------------------------ */
  /*
   * 第一次 invoke 不会执行工具，而是在 afterModel 阶段抛出 interrupt，
   * 把「待审批的动作」沉到 result.__interrupt__ 里，然后函数正常返回。
   *
   * 中断后 thread 处于「暂停」状态，绝不能用同一个 thread 再发一条新消息，
   * 那样会从断点继续而不是重新开始；恢复必须用 Command({ resume })。
   *
   * result.__interrupt__ 是数组（一次可能中断多件事），这里只取第一项。
   * Interrupt<HITLRequest> 的结构是 { id, value }，
   * value 里含 actionRequests（要执行什么工具、参数是什么）
   * 和 reviewConfigs（允许哪些决策）。
   */
  console.log("=== B1. 危险工具暂停 → 人工 approve（humanInTheLoopMiddleware）==="); // 场景标题
  console.log("用户：删除 note-1"); // 模拟用户输入

  const approveConfig = { configurable: { thread_id: "day8-hitl-approve" } }; // B1 专用 thread
  const firstResult = await agent.invoke(
    // 第一次调用：预期在工具执行前停下
    { messages: [new HumanMessage("删除 note-1")] }, // 输入：要求删除 note-1
    approveConfig, // 同一个 thread 后面要用它恢复
  );

  const interrupt = firstResult.__interrupt__?.[0] as Interrupt<HITLRequest> | undefined; // 取第一个中断（可能没有）

  if (!interrupt) {
    // 没有中断：说明模型没调用 delete_note（多半是它自己反问了）
    console.log("（没有触发中断：模型可能没有调用 delete_note）"); // 明确说明原因
    printToolTrace(firstResult.messages); // 打印轨迹帮助排查
    console.log(`最终回答：${lastAIText(firstResult.messages)}\n`); // 打印模型回答
  } else {
    // 正常情况：拿到中断对象
    console.log(`中断对象字段：${Object.keys(interrupt).join(", ")}`); // 顶层字段：id / value
    console.log(`中断 id：${interrupt.id}`); // 本次中断的唯一标识
    console.log(`value 字段：${Object.keys(interrupt.value).join(", ")}`); // value 内部字段
    console.log(`actionRequests：${JSON.stringify(interrupt.value.actionRequests, null, 2)}`); // 待审批动作详情（工具名/参数/描述）
    console.log(`reviewConfigs：${JSON.stringify(interrupt.value.reviewConfigs, null, 2)}`); // 审批规则（允许哪些决定）

    // decisions 是数组：一次中断里若有多条待审批动作，要按顺序一一作答
    const approve: HITLResponse = { decisions: [{ type: "approve" }] }; // 人工决定：通过
    console.log("人工决定：approve"); // 日志：记录决定
    // resume 会从断点继续：执行被批准的工具 → 把结果交给模型 → 生成最终回答
    const approvedResult = await agent.invoke(new Command({ resume: approve }), approveConfig); // 用 Command 恢复同一个 thread

    printToolTrace(approvedResult.messages); // 打印恢复后的轨迹：应出现 delete_note 的 ToolMessage
    console.log(`恢复后最终回答：${lastAIText(approvedResult.messages)}\n`); // 打印最终回答
  }

  /* ------------------------------------------------------------------------ */
  /* B. Human-in-the-loop：reject                                               */
  /* ------------------------------------------------------------------------ */
  /*
   * 用一个新的 thread_id 重新走一遍流程，避免复用上面已恢复的 thread。
   * reject 的 message 会作为 ToolMessage 内容回填给模型（status=error），
   * 模型据此知道操作被拒绝，再生成一段自然语言解释，而不是继续执行删除。
   * 也就是说：reject 不是「静默取消」，而是把拒绝原因变成对话的一部分。
   */
  console.log("=== B2. 危险工具暂停 → 人工 reject（新的 thread_id）==="); // 场景标题
  console.log("用户：删除 note-1"); // 模拟用户输入

  const rejectConfig = { configurable: { thread_id: "day8-hitl-reject" } }; // B2 独立 thread（不能复用 B1）
  const rejectFirst = await agent.invoke(
    // 第一次调用：同样预期中断
    { messages: [new HumanMessage("删除 note-1")] }, // 输入：要求删除 note-1
    rejectConfig, // B2 的 thread 配置
  );

  const rejectInterrupt = rejectFirst.__interrupt__?.[0] as Interrupt<HITLRequest> | undefined; // 取第一个中断

  if (!rejectInterrupt) {
    // 没中断：模型没调用工具
    console.log("（没有触发中断：模型可能没有调用 delete_note）"); // 说明原因
    printToolTrace(rejectFirst.messages); // 打印轨迹排查
    console.log(`最终回答：${lastAIText(rejectFirst.messages)}\n`); // 打印回答
  } else {
    // 正常：拿到中断对象
    console.log(`actionRequests：${JSON.stringify(rejectInterrupt.value.actionRequests, null, 2)}`); // 打印待审批动作

    // reject 必须带 message：它会被转成 ToolMessage 内容，告诉模型「为什么被拒绝」
    const reject: HITLResponse = {
      // 人工决定：拒绝
      decisions: [{ type: "reject", message: "演示模式禁止删除" }], // 拒绝并给出原因
    };
    console.log("人工决定：reject（演示模式禁止删除）"); // 日志：记录决定
    // 恢复后不会执行 delete_note，而是把拒绝原因交给模型，让模型向用户解释
    const rejectedResult = await agent.invoke(new Command({ resume: reject }), rejectConfig); // 用 Command 恢复

    printToolTrace(rejectedResult.messages); // 打印轨迹：没有 delete_note 成功结果，只有拒绝消息
    console.log(`恢复后最终回答：${lastAIText(rejectedResult.messages)}\n`); // 打印模型对拒绝的解释
  }

  /* ------------------------------------------------------------------------ */
  /* C. 自定义错误处理                                                          */
  /* ------------------------------------------------------------------------ */
  /*
   * 这里不挂 retry（broken_weather 不在白名单），异常会一路冒到最外层
   * toolErrorMiddleware，被转换成 status="error" 的 ToolMessage。
   *
   * 重点验证两件事：
   * 1. 进程不崩溃 —— 异常在 middleware 层被消化；
   * 2. 模型能看到中文错误并如实回复 —— 说明 ToolMessage 的 tool_call_id
   *    与原始调用对上了，否则模型会把这条消息当成「无关上下文」。
   */
  console.log("=== C. 工具抛异常 → 自定义 wrapToolCall 转成可读错误 ==="); // 场景标题
  console.log("用户：北京天气怎么样？"); // 模拟用户输入

  const weatherConfig = { configurable: { thread_id: "day8-weather" } }; // C 场景专用 thread
  const weatherResult = await agent.invoke(
    // 跑一轮：模型会调用 broken_weather，然后抛错
    { messages: [new HumanMessage("北京天气怎么样？")] }, // 输入：问天气
    weatherConfig, // C 的 thread 配置
  );

  printToolTrace(weatherResult.messages); // 打印轨迹：应出现 status=error 的 ToolMessage

  // 用类型守卫收窄为 ToolMessage，后面才能安全访问 name / status
  const weatherError = weatherResult.messages.find(
    // 在消息列表里找 broken_weather 的返回
    (message): message is ToolMessage => // 类型谓词：告诉 TS 命中后就是 ToolMessage
      ToolMessage.isInstance(message) && message.name === "broken_weather", // 必须是 ToolMessage 且工具名匹配
  );
  console.log(
    // 打印自定义 middleware 回填的错误文案
    `broken_weather 回填的 ToolMessage：${weatherError ? textOf(weatherError) : "（没有找到，模型可能没调用工具）"}`, // 找到就打印内容，否则给提示
  );
  console.log(`最终回答：${lastAIText(weatherResult.messages)}\n`); // 打印模型如何看待这个错误

  /* ------------------------------------------------------------------------ */
  /* D. 摘要                                                                    */
  /* ------------------------------------------------------------------------ */
  /*
   * trigger 是「达到阈值就压缩」，keep 是「压缩后保留最近多少条」：
   *   messages >= 8 触发 → 旧消息 RemoveMessage → 摘要(1 条) + 最近 4 条。
   *
   * 因此消息数会呈现「涨到 8 → 掉到 6 左右 → 再涨」的锯齿形，
   * 而不是一直单调增长。前几轮还没到阈值，数字只会往上走；
   * 到第 4、5 轮就能看到明显下降，这就是摘要生效的直观证据。
   *
   * 每轮前读一次 state、每轮后再读一次，是为了把「触发前/触发后」对比出来；
   * 只打印 invoke 结果的长度是看不出压缩动作的。
   */
  console.log("=== D. 对话变长后自动摘要（summarizationMiddleware）==="); // 场景标题
  console.log("策略：消息数 ≥ 8 时触发，压缩后保留最近 4 条\n"); // 打印阈值说明

  const summaryConfig = { configurable: { thread_id: "day8-summary" } }; // D 场景共用同一个 thread
  // 8 条短消息：前几句让模型调用 get_current_time（消息涨得更快），
  // 后面故意问「暗号」来验证摘要后是否还保留了最近上下文。
  // 全部用同一个 thread，否则每条都是新会话，永远触发不了阈值。
  const summaryTurns = [
    // 8 轮用户提问
    "现在几点？", // 第 1 轮：会调用 get_current_time
    "把刚才的时间用一句话复述。", // 第 2 轮：复用上一轮工具结果
    "今天适合做什么？一句话。", // 第 3 轮：普通对话
    "我刚才问过你什么？", // 第 4 轮：考查短期记忆
    "记住：暗号是蓝色海豚。", // 第 5 轮：埋一个需要记住的信息
    "暗号是什么？", // 第 6 轮：检查信息是否还在
    "再说一次现在几点。", // 第 7 轮：再次调用时间工具
    "总结一下我们这次对话。", // 第 8 轮：收尾，通常会触发摘要
  ];

  for (const [index, text] of summaryTurns.entries()) {
    // 逐轮执行，index 从 0 开始
    // 提问前先读一次：此时还没把本轮 HumanMessage 加进去，是「上一轮结束」的基数
    const before = await readState("day8-summary"); // 读压缩前的消息数
    console.log(`—— 第 ${index + 1} 轮 · 提问前消息数：${before.count} ——`); // 打印轮次与基数
    console.log(`用户：${text}`); // 打印本轮用户输入

    const result = await agent.invoke({ messages: [new HumanMessage(text)] }, summaryConfig); // 跑一轮 Agent
    console.log(`助手：${lastAIText(result.messages)}`); // 打印助手回答

    const after = await readState("day8-summary"); // 读本轮结束后的消息数
    console.log(`提问后消息数：${after.count}`); // 打印对比：正常情况下这里可能比 before 小
    if (after.summarized) {
      // 检测到摘要标记
      console.log("已检测到摘要消息：旧历史被 RemoveMessage 清掉，替换成一条 lc_source=summarization 的摘要"); // 说明压缩已发生
    }
    console.log(""); // 空行，分隔每一轮输出
  }

  console.log("演示结束。"); // 全部场景完成
}

try {
  // 顶层统一兜底：模型鉴权、网络、超时等问题都在这里翻译成中文提示，
  // 避免把一长串 SDK 堆栈直接抛给使用者。
  await main(); // 执行入口函数
} catch (error) {
  console.error(describeError(error)); // 把异常翻译成中文提示
  process.exit(1); // 非 0 退出码，方便脚本/CI 感知失败
}
