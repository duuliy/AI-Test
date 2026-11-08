/**
 * Day 5: 流式输出与取消
 *
 * 知识点：
 * - streamMode: "custom" 通过 config.writer 发送自定义进度事件
 * - streamMode: "updates" 推送每个节点的部分状态更新
 * - streamMode: "messages" 逐 token 推送模型生成的文本
 * - 多个 streamMode 可以用数组同时开启
 * - AbortSignal 可以取消正在执行的图
 *
 * 注意：本版（0.2.74）getWriter() 读取的是 configurable.writer，
 * 而 writer 实际挂在 config.writer 上，所以直接用 config.writer。
 */

import { z } from "zod";
import { StateGraph, START, END, MemorySaver } from "@langchain/langgraph";
import { withLangGraph } from "@langchain/langgraph/zod";
import { initModel, extractText } from "./model.js";
import type { LangGraphRunnableConfig } from "@langchain/langgraph";

// ─────────────────────────────────────────────
// 1. 定义一张用于流式演示的小图
// ─────────────────────────────────────────────

const StreamState = z.object({
  /** 任务描述 */
  task: z.string(),
  /** 生成的内容 */
  content: z.string().default(""),
  /** 执行步骤轨迹 */
  steps: withLangGraph(z.array(z.string()), {
    reducer: {
      fn: (left: string[], right: string[]) => left.concat(right),
    },
    default: () => [],
  }),
});

type StreamStateType = z.infer<typeof StreamState>;

/**
 * 生成节点：调用模型，并通过 writer 发送自定义进度事件
 * 节点函数第二个参数是 LangGraphRunnableConfig，writer 挂在 config 上
 */
async function generateNode(
  state: StreamStateType,
  config: LangGraphRunnableConfig,
): Promise<Partial<StreamStateType>> {
  // 本版 getWriter() 有 bug，直接从 config 取 writer
  const writer = config.writer;

  // 发送自定义进度事件（只有 streamMode 包含 "custom" 时才会推送）
  writer?.({ node: "generate", progress: 0.1, message: "开始生成" });
  writer?.({ node: "generate", progress: 0.3, message: "调用模型中" });

  let content = "";
  try {
    const { model } = initModel();
    const response = await model.invoke(state.task);
    content = extractText(response);
  } catch {
    content = `（兜底内容）关于"${state.task}"的示例文本，用于演示流式输出。`;
  }

  writer?.({ node: "generate", progress: 0.9, message: "生成完成" });

  return {
    content,
    steps: ["generate"],
  };
}

/**
 * 收尾节点：发送完成进度
 */
function finalizeNode(
  state: StreamStateType,
  config: LangGraphRunnableConfig,
): Partial<StreamStateType> {
  const writer = config.writer;
  writer?.({ node: "finalize", progress: 1.0, message: "全部完成" });

  return {
    steps: ["finalize"],
  };
}

// 组装图
const streamGraph = new StateGraph(StreamState)
  .addNode("generate", generateNode)
  .addNode("finalize", finalizeNode)
  .addEdge(START, "generate")
  .addEdge("generate", "finalize")
  .addEdge("finalize", END)
  .compile({
    checkpointer: new MemorySaver(),
  });

// ─────────────────────────────────────────────
// 2. 用于取消演示的慢图（节点内 sleep 模拟耗时操作）
// ─────────────────────────────────────────────

const SlowState = z.object({
  task: z.string(),
  result: z.string().default(""),
});

type SlowStateType = z.infer<typeof SlowState>;

/**
 * 慢节点：sleep 1 秒模拟耗时操作，确保取消信号能生效
 */
async function slowNode(state: SlowStateType): Promise<Partial<SlowStateType>> {
  // 模拟耗时操作（模型调用、IO 等）
  await new Promise((resolve) => setTimeout(resolve, 1000));
  return { result: `完成：${state.task}` };
}

const slowGraph = new StateGraph(SlowState)
  .addNode("slow", slowNode)
  .addEdge(START, "slow")
  .addEdge("slow", END)
  .compile({
    checkpointer: new MemorySaver(),
  });

// ─────────────────────────────────────────────
// 3. 演示三种 streamMode
// ─────────────────────────────────────────────

const TASK = "用一句话解释什么是流式输出（streaming）";

/**
 * streamMode: "custom" — 只打印自定义进度事件
 */
async function demoCustomStream() {
  console.log("\n" + "─".repeat(60));
  console.log('streamMode: "custom" — 自定义进度事件');
  console.log("─".repeat(60));

  const stream = await streamGraph.stream(
    { task: TASK },
    {
      configurable: { thread_id: "stream-custom" },
      streamMode: "custom",
    },
  );

  for await (const chunk of stream) {
    // custom 模式下 chunk 就是 writer 发送的对象
    const event = chunk as { node: string; progress: number; message: string };
    console.log(`  [custom] ${event.node} | progress=${event.progress} | ${event.message}`);
  }
}

/**
 * streamMode: ["updates", "custom"] — 同时打印节点更新和自定义事件
 * 多模式时，每个 chunk 是 [mode, payload] 元组
 */
async function demoUpdatesAndCustomStream() {
  console.log("\n" + "─".repeat(60));
  console.log('streamMode: ["updates", "custom"] — 节点更新 + 自定义事件');
  console.log("─".repeat(60));

  const stream = await streamGraph.stream(
    { task: TASK },
    {
      configurable: { thread_id: "stream-updates-custom" },
      streamMode: ["updates", "custom"],
    },
  );

  for await (const chunk of stream) {
    // 多模式时 chunk 是 [mode, payload]
    const [mode, payload] = chunk as [string, unknown];
    if (mode === "custom") {
      const event = payload as { node: string; progress: number; message: string };
      console.log(`  [custom]  ${event.node} | progress=${event.progress} | ${event.message}`);
    } else if (mode === "updates") {
      // updates 模式下 payload 是 { [节点名]: { 字段更新 } }
      const updates = payload as Record<string, Record<string, unknown>>;
      for (const [nodeName, fields] of Object.entries(updates)) {
        const keys = Object.keys(fields).join(", ");
        console.log(`  [updates] 节点 ${nodeName} 更新了字段: ${keys}`);
      }
    }
  }
}

/**
 * streamMode: "messages" — 逐 token 打印模型生成的文本
 * 通过 callbacks 捕获模型调用产生的消息块
 * 注意：需要真实模型调用才会产生 token；未配置 API key 时无输出
 */
async function demoMessagesStream() {
  console.log("\n" + "─".repeat(60));
  console.log('streamMode: "messages" — 逐 token 模型输出');
  console.log("─".repeat(60));

  const stream = await streamGraph.stream(
    { task: TASK },
    {
      configurable: { thread_id: "stream-messages" },
      streamMode: "messages",
    },
  );

  // 用 process.stdout.write 实现逐字输出效果（不换行）
  process.stdout.write("  模型输出: ");
  let hasOutput = false;
  for await (const chunk of stream) {
    hasOutput = true;
    // messages 模式下 chunk 是 [message, metadata] 元组
    // message 是 AIMessageChunk，content 为字符串
    const [message] = chunk as [{ content: string | unknown[] }, unknown];
    const content = message.content;
    if (typeof content === "string") {
      process.stdout.write(content);
    } else if (Array.isArray(content)) {
      for (const block of content) {
        if (typeof block === "object" && block !== null && "text" in block) {
          process.stdout.write((block as { text: string }).text);
        }
      }
    }
  }
  if (!hasOutput) {
    process.stdout.write("（无输出：未配置 API key 或模型调用失败，messages 流需要真实模型调用产生 token）");
  }
  process.stdout.write("\n");
}

// ─────────────────────────────────────────────
// 4. 取消演示
// ─────────────────────────────────────────────

/**
 * 用 AbortController 取消一次图执行
 * 300ms 后调用 abort()，signal 传给 stream
 * 捕获到的错误类型通常是 Error（name === "AbortError"）
 */
async function demoAbort() {
  console.log("\n" + "─".repeat(60));
  console.log("取消演示：AbortController 300ms 后 abort");
  console.log("─".repeat(60));

  const controller = new AbortController();
  // 300ms 后触发取消
  const timeout = setTimeout(() => controller.abort(), 300);

  try {
    const stream = await slowGraph.stream(
      { task: "一个会执行 1 秒的慢任务" },
      {
        configurable: { thread_id: "stream-abort" },
        streamMode: "values",
        signal: controller.signal,
      },
    );

    // 消费流，取消时会抛出异常
    for await (const _chunk of stream) {
      // 不关心内容，只等取消发生
    }

    console.log("  （未触发取消，流程正常结束）");
  } catch (error) {
    // 捕获取消错误，正常退出
    const name = error instanceof Error ? error.name : String(error);
    const message = error instanceof Error ? error.message : String(error);
    console.log("  ✅ 已取消");
    console.log(`  错误类型: ${name}`);
    console.log(`  错误信息: ${message}`);
  } finally {
    clearTimeout(timeout);
  }
}

// ─────────────────────────────────────────────
// 5. 运行所有演示
// ─────────────────────────────────────────────

async function runStreamDemo() {
  console.log("=".repeat(60));
  console.log("Day 5: 流式输出与取消");
  console.log("=".repeat(60));

  await demoCustomStream();
  await demoUpdatesAndCustomStream();
  await demoMessagesStream();
  await demoAbort();

  console.log("\n" + "=".repeat(60));
  console.log("✅ 流式与取消演示完成");
  console.log("=".repeat(60));
}

runStreamDemo().catch((err) => {
  console.error("运行出错：", err);
  process.exit(1);
});
