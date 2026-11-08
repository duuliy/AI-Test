/**
 * Day 5: 中断、人工审批与流式
 *
 * 知识点：
 * - interrupt(value) 在节点内暂停图执行，抛出 GraphInterrupt 特殊异常
 * - 恢复必须用 new Command({ resume }) 且同一个 thread_id
 * - interrupt 依赖 checkpointer 保存断点状态，MemorySaver 也可（重启即丢）
 * - 本版 interrupt 不支持 responseSchema 参数，恢复值用 zod 手动校验
 */

import { z } from "zod";
import { StateGraph, START, END, interrupt, Command, MemorySaver } from "@langchain/langgraph";
import { withLangGraph } from "@langchain/langgraph/zod";
import { initModel, extractText } from "./model.js";

// ─────────────────────────────────────────────
// 1. 定义状态
// ─────────────────────────────────────────────

const GraphState = z.object({
  /** 原始任务描述 */
  task: z.string(),
  /** 当前草稿内容 */
  draft: z.string().default(""),
  /** 审批决定 */
  decision: z.enum(["pending", "approve", "reject"]).default("pending"),
  /** 审批反馈意见（拒绝时填写，用于改稿） */
  feedback: z.string().default(""),
  /** 最终发布内容 */
  published: z.string().default(""),
  /** 改稿次数（每轮草稿生成 +1） */
  revisions: z.number().default(0),
});

type GraphStateType = z.infer<typeof GraphState>;

// ─────────────────────────────────────────────
// 2. 恢复值的 schema 校验
// ─────────────────────────────────────────────

/**
 * 审批恢复值的约束 schema。
 * 由于本版 interrupt() 不支持 responseSchema 参数，
 * 在拿到 interrupt() 返回值后手动用 zod 校验。
 */
const resumeSchema = z.object({
  decision: z.enum(["approve", "reject"]),
  feedback: z.string().optional(),
});

type ResumeValue = z.infer<typeof resumeSchema>;

// ─────────────────────────────────────────────
// 3. 节点
// ─────────────────────────────────────────────

/**
 * draftNode：根据 task 和上一轮 feedback 生成新草稿
 * 调用模型生成内容，返回 { draft, decision: "pending", revisions + 1 }
 */
async function draftNode(state: GraphStateType): Promise<Partial<GraphStateType>> {
  const { task, feedback } = state;
  // 注意：本版 LastValue channel 不应用 zod default()，普通字段初始为 undefined
  // 所以用 ?? 兜底
  const revisions = (state.revisions ?? 0) + 1;

  // 构造 prompt：如果有上一轮反馈，要求模型根据反馈修改
  let prompt = `请完成以下任务：\n${task}`;
  if (feedback) {
    prompt += `\n\n上一轮审批反馈：${feedback}\n请根据反馈修改后重新输出。`;
  }

  let draft = "";
  try {
    const { model } = initModel();
    const response = await model.invoke(prompt);
    draft = extractText(response);
  } catch {
    // 模型不可用时的兜底草稿
    draft = feedback
      ? `（修改后草稿）根据反馈"${feedback}"修订的内容：${task} —— 已补充具体示例。`
      : `（初始草稿）关于"${task}"的内容草稿。`;
  }

  return {
    draft,
    decision: "pending",
    revisions: revisions + 1,
  };
}

/**
 * reviewNode：调用 interrupt() 暂停，等待人工审批
 * 恢复值必须符合 resumeSchema：{ decision: "approve" | "reject", feedback?: string }
 */
function reviewNode(state: GraphStateType): Partial<GraphStateType> {
  const { draft, task } = state;

  // interrupt 抛出 GraphInterrupt 暂停图执行
  // 恢复时 interrupt() 返回 Command({ resume }) 中传入的值
  const rawResume = interrupt<unknown, ResumeValue>({
    type: "approval_request",
    task,
    draft,
  });

  // 用 zod 校验恢复值（本版 interrupt 无 responseSchema，手动校验）
  const resume = resumeSchema.parse(rawResume);

  return {
    decision: resume.decision,
    feedback: resume.feedback ?? "",
  };
}

/**
 * publishNode：审批通过后发布
 */
function publishNode(state: GraphStateType): Partial<GraphStateType> {
  return {
    published: `已发布：\n${state.draft}`,
  };
}

/**
 * reviseNode：记录拒绝步骤，然后回到 draft 重新生成
 * 这里只做记录，实际路由由条件边完成
 */
function reviseNode(state: GraphStateType): Partial<GraphStateType> {
  // 不需要修改状态，decision 已在 reviewNode 设为 "reject"
  // feedback 也已写入，draftNode 会读取它来改稿
  return {};
}

// ─────────────────────────────────────────────
// 4. 条件边路由
// ─────────────────────────────────────────────

/**
 * 根据 reviewNode 写入的 decision 决定下一个节点
 * approve → publish，reject → revise
 */
function routeAfterReview(state: GraphStateType): string {
  if (state.decision === "approve") return "publish";
  return "revise";
}

// ─────────────────────────────────────────────
// 5. 组装图（用 MemorySaver 编译，支持中断恢复）
// ─────────────────────────────────────────────

// 注意：节点名不能与状态字段同名（draft 是状态字段，所以节点用 generate_draft）
const graphBuilder = new StateGraph(GraphState)
  .addNode("generate_draft", draftNode)
  .addNode("review", reviewNode)
  .addNode("publish", publishNode)
  .addNode("revise", reviseNode)
  .addEdge(START, "generate_draft")
  .addEdge("generate_draft", "review")
  .addConditionalEdges("review", routeAfterReview, {
    publish: "publish",
    revise: "revise",
  })
  .addEdge("revise", "generate_draft")
  .addEdge("publish", END);

// 必须传入 checkpointer，否则 interrupt 无法保存断点、恢复会失败
const graph = graphBuilder.compile({
  checkpointer: new MemorySaver(),
});

// ─────────────────────────────────────────────
// 6. 演示三条审批路径
// ─────────────────────────────────────────────

async function runApprovalDemo() {
  console.log("=".repeat(60));
  console.log("Day 5: 中断、人工审批与流式 — 审批流程");
  console.log("=".repeat(60));

  const task = "写一段关于 LangGraph interrupt 机制的介绍";

  // ═══════════════════════════════════════════════════════════
  // 路径 A：直接通过
  // ═══════════════════════════════════════════════════════════
  console.log("\n" + "─".repeat(60));
  console.log("路径 A：审批通过");
  console.log("─".repeat(60));

  {
    const threadId = "approval-approve";
    const config = { configurable: { thread_id: threadId } };

    // 首次 invoke：执行 draft → review，在 review 处 interrupt 暂停
    const result = await graph.invoke({ task }, config);

    // 中断后 invoke 返回的是中断时的状态
    // __interrupt__ 字段包含中断值（本版通过 updates 流暴露，
    // 这里直接从状态和 getState 观察中断信息）
    console.log("\n首次 invoke 后状态：");
    console.log(`  draft 前 80 字: ${result.draft.slice(0, 80)}${result.draft.length > 80 ? "…" : ""}`);
    console.log(`  decision: ${result.decision}`);
    console.log(`  revisions: ${result.revisions}`);
    console.log(`  published: "${result.published ?? ""}"`);

    // 用 getState 查看中断信息（tasks 里的 interrupts 字段）
    const snapshot = await graph.getState(config);
    console.log("\n通过 getState 查看中断信息：");
    for (const taskInfo of snapshot.tasks) {
      if (taskInfo.interrupts.length > 0) {
        console.log(`  中断节点: ${taskInfo.name}`);
        console.log(`  中断值: ${JSON.stringify(taskInfo.interrupts[0].value, null, 2)}`);
      }
    }

    // 用 Command({ resume }) 恢复，同一个 thread_id
    const resumeResult = await graph.invoke(
      new Command({ resume: { decision: "approve" } }),
      config,
    );

    console.log("\n审批通过后：");
    console.log(`  decision: ${resumeResult.decision}`);
    console.log(`  published:\n${resumeResult.published}`);
  }

  // ═══════════════════════════════════════════════════════════
  // 路径 B：拒绝并改稿，第二次通过
  // ═══════════════════════════════════════════════════════════
  console.log("\n" + "─".repeat(60));
  console.log("路径 B：拒绝 → 改稿 → 第二次通过");
  console.log("─".repeat(60));

  {
    const threadId = "approval-reject";
    const config = { configurable: { thread_id: threadId } };

    // 首次 invoke：draft → review，中断
    const firstResult = await graph.invoke({ task }, config);
    console.log(`\n首次草稿（revision ${firstResult.revisions}）：`);
    console.log(`  ${firstResult.draft.slice(0, 100)}${firstResult.draft.length > 100 ? "…" : ""}`);

    // 用 Command 恢复，decision=reject 并附带 feedback
    const rejectResult = await graph.invoke(
      new Command({
        resume: { decision: "reject", feedback: "太泛了，补一个具体例子" },
      }),
      config,
    );

    // reject 后图回到 draft → review，再次中断
    console.log(`\n拒绝后回到 draft，再次中断（revision ${rejectResult.revisions}）：`);
    console.log(`  decision: ${rejectResult.decision}`);
    console.log(`  feedback: "${rejectResult.feedback}"`);
    console.log(`  新草稿前 100 字: ${rejectResult.draft.slice(0, 100)}${rejectResult.draft.length > 100 ? "…" : ""}`);

    // 确认反馈体现在草稿中
    const feedbackIncorporated = rejectResult.draft.includes("例子") || rejectResult.draft.includes("例如");
    console.log(`  反馈已体现: ${feedbackIncorporated ? "✅" : "❌（兜底草稿未含关键词，但流程正确）"}`);

    // 第二次恢复：approve
    const finalResult = await graph.invoke(
      new Command({ resume: { decision: "approve" } }),
      config,
    );

    console.log("\n第二次审批通过后：");
    console.log(`  decision: ${finalResult.decision}`);
    console.log(`  revisions: ${finalResult.revisions}`);
    console.log(`  published:\n${finalResult.published}`);
  }

  // ═══════════════════════════════════════════════════════════
  // 路径 C：错误用法对照（说明，不实际执行错误操作）
  // ═══════════════════════════════════════════════════════════
  console.log("\n" + "─".repeat(60));
  console.log("路径 C：错误用法对照（说明）");
  console.log("─".repeat(60));

  console.log(`
错误用法：中断后，用同一个 thread_id 直接发送新的输入（如新的 task）。

原因：
  LangGraph 的 checkpointer 会记录该 thread_id 上一次执行停在哪个节点。
  如果直接 invoke({ task: "新任务" })，框架会发现该线程有未完成的断点，
  不会把新输入当作"重新开始"，而是尝试从断点继续执行。
  对于中断状态，没有 resume 值的话会再次抛出 GraphInterrupt，
  或者把新输入错误地合并到断点状态中，导致行为不可预期。

正确做法（二选一）：
  1. 用 new Command({ resume: ... }) 恢复当前线程，让图从断点继续
  2. 换一个新的 thread_id，启动一条全新的执行链路
`);

  console.log("\n" + "=".repeat(60));
  console.log("✅ 审批流程演示完成");
  console.log("=".repeat(60));
}

// 导出图供 stream.ts 复用
export { graph, GraphState, type GraphStateType };

runApprovalDemo().catch((err) => {
  console.error("运行出错：", err);
  process.exit(1);
});
