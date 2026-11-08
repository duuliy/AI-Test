/**
 * Day 4: 时间旅行 —— 从历史 checkpoint 恢复、updateState 分叉、旧分支不受影响
 *
 * checkpoint 的分支语义（以 0.2.74 实际行为为准）：
 * - 每个超步结束都会存一个 checkpoint，checkpoint 之间通过 parent 指针串成链
 * - getStateHistory 按创建时间倒序（新 → 旧）遍历该线程的整条链
 * - updateState(旧 checkpoint 的 config, values, asNode) 会以旧 checkpoint 为
 *   parent 新建一个 checkpoint（metadata.source = "update"），等价于在时间线上开分支：
 *   values 像是被 asNode 节点写进去的，next 指向它在图里的后继节点
 * - 用 updateState 返回的 config 继续执行，后续节点都发生在新分支上；
 *   旧分支的 checkpoint 不会被删除，历史里新旧两条链都可见
 */

import { z } from "zod";
import { StateGraph, START, END, MemorySaver } from "@langchain/langgraph";
import { withLangGraph } from "@langchain/langgraph/zod";
import type { StateSnapshot } from "@langchain/langgraph";
import type { RunnableConfig } from "@langchain/core/runnables";

// ─────────────────────────────────────────────
// 1. 状态与节点（全程确定性，不调用模型，便于观察分支差异）
// ─────────────────────────────────────────────

const WriteState = z.object({
  /** 选题 */
  topic: z.string(),
  /**
   * 草稿/终稿内容
   * 提示词里的字段名是 draft，但 LangGraph 不允许节点名和状态字段同名
   * （Day 1 已验证过这条规则），四个节点要叫 plan/draft/check/final，
   * 所以这里把字段改名为 draftText
   */
  draftText: z.string().default(""),
  /** 执行步骤轨迹：reducer 累积 */
  steps: withLangGraph(z.array(z.string()), {
    reducer: {
      fn: (left: string[], right: string[]) => left.concat(right),
    },
    default: () => [],
  }),
});

type WriteStateType = z.infer<typeof WriteState>;

/** plan：返回选题和步骤 */
function plan(_state: WriteStateType): Partial<WriteStateType> {
  return {
    topic: "LangGraph 持久化",
    steps: ["plan"],
  };
}

/** draft：返回一版草稿 */
function draft(state: WriteStateType): Partial<WriteStateType> {
  return {
    draftText: `《${state.topic}》：checkpointer 会在每个超步后保存完整状态快照……`,
    steps: ["draft"],
  };
}

/** check：只记录步骤，不改内容 */
function check(_state: WriteStateType): Partial<WriteStateType> {
  return { steps: ["check"] };
}

/** final：输出终稿（直接基于当前 draftText 加终稿标记） */
function final(state: WriteStateType): Partial<WriteStateType> {
  return {
    draftText: `【终稿】${state.draftText}`,
    steps: ["final"],
  };
}

// ─────────────────────────────────────────────
// 2. 图：plan → draft → check → final，MemorySaver + 固定 thread_id
// ─────────────────────────────────────────────

const graph = new StateGraph(WriteState)
  .addNode("plan", plan)
  .addNode("draft", draft)
  .addNode("check", check)
  .addNode("final", final)
  .addEdge(START, "plan")
  .addEdge("plan", "draft")
  .addEdge("draft", "check")
  .addEdge("check", "final")
  .addEdge("final", END)
  .compile({ checkpointer: new MemorySaver() });

const THREAD = { configurable: { thread_id: "time-travel" } };

// ─────────────────────────────────────────────
// 3. 工具：打印 checkpoint 历史
// ─────────────────────────────────────────────

/** 收集 getStateHistory（新 → 旧）到数组 */
async function collectHistory(): Promise<StateSnapshot[]> {
  const snapshots: StateSnapshot[] = [];
  const history = await graph.getStateHistory(THREAD);
  for await (const snapshot of history) {
    snapshots.push(snapshot);
  }
  return snapshots;
}

/**
 * 从某个 checkpoint 续跑（0.2.74 zod 图的版本限制与对策）：
 * - 标准写法 invoke(null, config) 在 0.2.74 的 zod 图上行不通：
 *   CompiledStateGraph._validateInput 对任何 input 都执行 inputSchema.parse，
 *   parse(null) 直接抛 ZodError（实测确认）
 * - PregelLoop.isResuming 认三个信号：input 为 null/undefined（被上面拦了）、
 *   Command(resume)（无 interrupt 时抛 EmptyInputError）、configurable.__pregel_resuming
 * - 所以这里传 schema 合法的占位输入 + __pregel_resuming 标志；
 *   resume 状态下 input 不会写入通道（源码 _first 中 isResuming 分支跳过 inputWrites），
 *   语义与 invoke(null, config) 等价（实测：从 next 处继续，steps 正常累积，不重跑旧节点）
 */
async function resumeFrom(config: RunnableConfig): Promise<WriteStateType> {
  return graph.invoke(
    { topic: "（占位：resume 时不写入状态）" },
    { configurable: { ...config.configurable, __pregel_resuming: true } }
  );
}

function printHistory(title: string, snapshots: StateSnapshot[]): void {
  console.log(`\n${title}（共 ${snapshots.length} 个，新 → 旧）`);
  console.log("-".repeat(60));
  for (const snapshot of snapshots) {
    // uuid6 前缀是时间戳，同一批生成的 id 前缀相同，取尾 8 位区分
    const cid = (snapshot.config.configurable as { checkpoint_id?: string }).checkpoint_id ?? "-";
    const steps = (snapshot.values?.steps as string[] | undefined)?.join(",") ?? "";
    const draftText = (snapshot.values?.draftText as string | undefined) ?? "";
    console.log(
      `  checkpoint=…${cid.slice(-8)}  next=[${snapshot.next.join(",")}]  ` +
        `steps=[${steps}]  draft=${draftText ? `"${draftText.slice(0, 24)}…"` : "(空)"}`
    );
  }
}

// ─────────────────────────────────────────────
// 4. 演示流程
// ─────────────────────────────────────────────

async function main() {
  console.log("=".repeat(60));
  console.log("Day 4: 时间旅行");
  console.log("=".repeat(60));

  // ① 完整跑一次
  const firstRun = await graph.invoke({ topic: "占位（会被 plan 覆盖）" }, THREAD);
  console.log(`\n① 原始终稿: ${firstRun.draftText}`);

  // ② 回放历史快照
  const history1 = await collectHistory();
  printHistory("② getStateHistory", history1);

  // ③ 选一个位于 draft 之后的 checkpoint：next = ["check"] 即「draft 刚跑完」的时刻
  const draftDone = history1.find((s) => s.next.length === 1 && s.next[0] === "check");
  if (!draftDone) throw new Error("没找到 next=[\"check\"] 的 checkpoint");
  const draftDoneId = (draftDone.config.configurable as { checkpoint_id?: string }).checkpoint_id;
  console.log(`\n③ 选中的 checkpoint: …${draftDoneId!.slice(-8)}（用 updateState 改 draft，asNode="draft"）`);

  // ④ updateState 分叉：以该 checkpoint 为 parent 新建 checkpoint，draftText 被覆盖
  const newConfig = await graph.updateState(
    draftDone.config,
    { draftText: "改过的草稿：这是从 draft 之后分叉出来的内容" },
    "draft"
  );
  const newId = (newConfig.configurable as { checkpoint_id?: string }).checkpoint_id;
  console.log(`   新分支 checkpoint: …${newId!.slice(-8)}，next 应为 ["check"]`);

  // ⑤ 用新 config 继续执行（见 resumeFrom 注释：等价于 invoke(null, config)）
  const rerun = await resumeFrom(newConfig);
  console.log(`\n⑤ 新分支终稿: ${rerun.draftText}`);

  // ⑥ 再次回放：旧分支的历史仍然存在，新分支多出 update 后的 checkpoint
  const history2 = await collectHistory();
  printHistory("⑥ updateState 后的 getStateHistory", history2);

  console.log("\n结论：");
  console.log(`  原终稿: ${firstRun.draftText.slice(0, 40)}…`);
  console.log(`  新终稿: ${rerun.draftText.slice(0, 40)}…`);
  console.log(`  旧分支 checkpoint 链仍在历史中（${history2.length} 个 >= ${history1.length} 个）`);
}

main().catch((err) => {
  console.error("运行出错：", err);
  process.exit(1);
});
