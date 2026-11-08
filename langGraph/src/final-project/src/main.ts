/**
 * CLI：运行带人工审批的研究助手。
 *
 * 用法：
 *   npm run start -- --thread=demo
 *   npm run start -- --thread=demo --resume=approve
 *   npm run start -- --thread=demo --resume=reject --feedback="补充一个具体例子"
 */

import { Command } from "@langchain/langgraph";
import { SqliteSaver } from "@langchain/langgraph-checkpoint-sqlite";
import { fileURLToPath } from "node:url";

import { createResearchGraph, type ApprovalRequest } from "./graph.js";
import type { ResearchStateType } from "./state.js";
import { readConfig, describeError } from "./config.js";

/** SQLite 文件放在子项目根目录，并已加入 .gitignore */
const DB_PATH = fileURLToPath(new URL("../checkpoints.db", import.meta.url));

const DEFAULT_QUESTION =
  "LangGraph 如何用检查点和 interrupt 实现跨进程的人工审批？";

interface CliOptions {
  thread: string;
  resume: "approve" | "reject" | null;
  feedback: string;
  question: string;
}

function readArg(name: string): string | undefined {
  const prefix = `--${name}=`;
  const arg = process.argv.find((item) => item.startsWith(prefix));
  return arg?.slice(prefix.length);
}

function parseOptions(): CliOptions {
  const thread = readArg("thread") ?? "demo";
  const resumeValue = readArg("resume");
  const feedback = readArg("feedback") ?? "";
  const question = readArg("question") ?? DEFAULT_QUESTION;

  if (resumeValue !== undefined && resumeValue !== "approve" && resumeValue !== "reject") {
    throw new Error(`--resume 只支持 approve | reject，收到 "${resumeValue}"`);
  }

  return {
    thread,
    resume: resumeValue ?? null,
    feedback,
    question,
  };
}

async function main(): Promise<void> {
  const options = parseOptions();

  if (!readConfig()) {
    console.warn(
      "未检测到 OPENAI_API_KEY / OPENAI_BASE_URL / OPENAI_MODEL，" +
        "plan / draft / review 将使用本地规则兜底。\n",
    );
  }

  const checkpointer = SqliteSaver.fromConnString(DB_PATH);
  const graph = createResearchGraph(checkpointer);
  const config = { configurable: { thread_id: options.thread }, recursionLimit: 25 };

  try {
    const before = await graph.getState(config);
    const pendingBefore = before.tasks.filter((task) => task.interrupts.length > 0);

    // ── 恢复路径：必须存在待审批中断 ──
    if (options.resume) {
      if (options.resume === "approve" && options.feedback) {
        console.error("--feedback 只能和 --resume=reject 一起使用。");
        process.exitCode = 1;
        return;
      }

      if (pendingBefore.length === 0) {
        console.error(
          `线程 "${options.thread}" 当前没有待审批的中断，无法 --resume。\n` +
            `如果要做新一轮，请换一个 --thread，或先执行不带 --resume 的命令。`,
        );
        process.exitCode = 1;
        return;
      }

      console.log(`恢复线程 "${options.thread}"：${options.resume}`);

      const resumeValue = {
        decision: options.resume,
        feedback: options.feedback,
      };
      await streamRun(graph, new Command({ resume: resumeValue }), config);
      await printOutcome(graph, config, options.thread);
      return;
    }

    // ── 首次运行：拒绝在已有历史/待审批的线程上重复开始 ──
    if (pendingBefore.length > 0) {
      console.error(
        `线程 "${options.thread}" 正停在审批中断，请使用 --resume=approve|reject 继续，` +
          `或换一个 --thread 开始新会话。`,
      );
      process.exitCode = 1;
      return;
    }

    if (before.values.question) {
      console.error(
        `线程 "${options.thread}" 已经完成过一轮，不能直接重复开始。\n` +
          `请换一个 --thread，或删除 checkpoints.db 后再试。`,
      );
      process.exitCode = 1;
      return;
    }

    console.log(`开始线程 "${options.thread}"\n问题：${options.question}`);
    await streamRun(graph, { question: options.question }, config);
    await printOutcome(graph, config, options.thread);
  } finally {
    checkpointer.db.close();
  }
}

/** 用 custom 流打印节点进度，跑完或中断后自然结束 */
async function streamRun(
  graph: ReturnType<typeof createResearchGraph>,
  input: { question: string } | Command,
  config: { configurable: { thread_id: string }; recursionLimit: number },
): Promise<void> {
  const startedAt = Date.now();

  const stream = await graph.stream(input, {
    ...config,
    streamMode: "custom",
  });

  for await (const chunk of stream) {
    const event = chunk as { node?: string; message?: string };
    if (event?.node) {
      console.log(`[${event.node}] ${event.message ?? ""}`);
    }
  }

  console.log(`（本次执行耗时 ${Date.now() - startedAt}ms）`);
}

/** 执行结束后：有中断就打印审批内容与下一步命令，否则打印最终稿 */
async function printOutcome(
  graph: ReturnType<typeof createResearchGraph>,
  config: { configurable: { thread_id: string }; recursionLimit: number },
  thread: string,
): Promise<void> {
  const snapshot = await graph.getState(config);
  const pending = snapshot.tasks.find((task) => task.interrupts.length > 0);

  if (pending) {
    const request = pending.interrupts[0].value as ApprovalRequest;

    console.log("\n" + "─".repeat(60));
    console.log(`流程在 "${pending.name}" 节点中断，等待人工审批`);
    console.log("中断内容：");
    console.log(JSON.stringify(request, null, 2));
    console.log("当前草稿：\n" + request.draft);
    console.log("\n下一步命令：");
    console.log(`  npm run start -- --thread=${thread} --resume=approve`);
    console.log(
      `  npm run start -- --thread=${thread} --resume=reject --feedback="补充一个具体例子"`,
    );
    console.log("─".repeat(60));
    return;
  }

  const values = snapshot.values as Partial<ResearchStateType>;

  console.log("\n" + "─".repeat(60));
  console.log("最终稿");
  console.log("─".repeat(60));
  console.log(values.finalAnswer ?? "");
  console.log(
    `\n（草稿版本 ${values.revisions ?? 0}，检索片段 ${(values.findings ?? []).length} 条）`,
  );
}

main().catch((error: unknown) => {
  console.error("运行出错：", describeError(error));
  process.exitCode = 1;
});
