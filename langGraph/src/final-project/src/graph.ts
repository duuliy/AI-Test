/**
 * 主图：plan → (Send 并行 research) → draftNode → review
 *        → approval(interrupt) → finalize → END
 */

import { z } from "zod";
import { StateGraph, START, END, Send, interrupt } from "@langchain/langgraph";
import type { LangGraphRunnableConfig, BaseCheckpointSaver } from "@langchain/langgraph";
import { ResearchState, type ResearchStateType, type Finding } from "./state.js";
import { researchSubgraph } from "./research-subgraph.js";
import { tryCreateModel, extractText, describeError } from "./config.js";

// ─────────────────────────────────────────────
// 结构化输出 schema
// ─────────────────────────────────────────────

const PlanSchema = z.object({
  queries: z.array(z.string()).describe("2 到 3 个适合关键词检索的子问题"),
});

const ReviewSchema = z.object({
  passed: z.boolean().describe("草稿是否完整回答且每条结论都有来源"),
  missing: z.array(z.string()).describe("尚未覆盖的检查项，没有则为空数组"),
});

const ApprovalRequestSchema = z.object({
  type: z.literal("approval_request"),
  question: z.string(),
  draft: z.string(),
  missing: z.array(z.string()),
});

type ApprovalRequest = z.infer<typeof ApprovalRequestSchema>;

/** interrupt 恢复值约束：本版 interrupt 无 responseSchema 参数，手动用 zod 校验 */
const ApprovalResumeSchema = z.object({
  decision: z.enum(["approve", "reject"]),
  feedback: z.string().optional(),
});

type ApprovalResume = z.infer<typeof ApprovalResumeSchema>;

// ─────────────────────────────────────────────
// 工具函数
// ─────────────────────────────────────────────

function emit(config: LangGraphRunnableConfig, node: string, message: string): void {
  config.writer?.({ node, message });
}

function formatEvidence(findings: Finding[]): string {
  if (findings.length === 0) return "（知识库中没有检索到相关片段）";
  return findings
    .slice(0, 3)
    .map((finding) => `[来源: ${finding.source}#${finding.chunkIndex}] ${finding.text}`)
    .join("\n\n");
}

/** 只给来源列表，用于自检，避免把全部资料再塞进一次模型调用 */
function formatSources(findings: Finding[]): string {
  if (findings.length === 0) return "（无）";
  const sources = Array.from(
    new Set(findings.map((finding) => `${finding.source}#${finding.chunkIndex}`)),
  );
  return sources.join("、");
}

/** 模型不可用时的规则拆分：按并列词切分，并去掉泛化的疑问词 */
function fallbackQueries(question: string): string[] {
  const cleaned = question.replace(/[？?！!。]/g, " ").trim();
  const parts = cleaned
    .split(/[和与及、，,]+|以及/)
    .map((part) => part.trim())
    .filter((part) => part.length >= 2);

  const variants = new Set<string>([question]);

  if (parts.length > 1) {
    for (const part of parts) variants.add(part);
  } else {
    const stripped = cleaned
      .replace(/(如何|怎么|怎样|为什么|是什么|什么|请|帮我|一下)/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    if (stripped) variants.add(stripped);
  }

  return Array.from(variants).slice(0, 3);
}

function describeFinding(finding: Finding): string {
  return `[来源: ${finding.source}#${finding.chunkIndex}]`;
}

// ─────────────────────────────────────────────
// 节点
// ─────────────────────────────────────────────

/** plan：用结构化输出把问题拆成 2～3 个检索子问题 */
async function planNode(
  state: ResearchStateType,
  config: LangGraphRunnableConfig,
): Promise<Partial<ResearchStateType>> {
  emit(config, "plan", "拆分研究问题");

  let queries: string[] = [];
  const model = tryCreateModel();

  if (model) {
    try {
      const planner = model.withStructuredOutput(PlanSchema);
      const result = await planner.invoke(
        `把下面的研究问题拆成 2 到 3 个适合本地关键词检索的中文子问题，只输出 queries 数组。\n\n问题：${state.question}`,
      );
      queries = result.queries.map((query) => query.trim()).filter(Boolean);
    } catch (error) {
      console.warn(`[plan] 模型调用失败，改用规则拆分：${describeError(error)}`);
    }
  }

  if (queries.length < 2) queries = fallbackQueries(state.question);
  queries = queries.slice(0, 3);

  emit(config, "plan", `拆成 ${queries.length} 个子问题：${queries.join(" | ")}`);

  return { queries, steps: ["plan"] };
}

/** draftNode：基于 findings 与上一轮 feedback 生成草稿（节点名不能与状态字段 draft 同名） */
async function draftNode(
  state: ResearchStateType,
  config: LangGraphRunnableConfig,
): Promise<Partial<ResearchStateType>> {
  const revisions = (state.revisions ?? 0) + 1;
  const findings = state.findings ?? [];
  const feedback = state.feedback ?? "";

  emit(config, "draftNode", `生成第 ${revisions} 版草稿`);

  let draft = "";
  const model = tryCreateModel();

  if (model) {
    try {
      const prompt = [
        "你是研究助手。只根据给定的检索资料撰写研究草稿，不要补充资料之外的事实。",
        `问题：${state.question}`,
        `检索资料：\n${formatEvidence(findings)}`,
        feedback ? `上一轮审批反馈：${feedback}\n请根据反馈修改后重新输出。` : "",
        "要求：",
        "1. 每个结论后标注 [来源: 文件名#段落]",
        "2. 如果资料不足以回答，明确写“知识库中未找到相关依据”，不要编造",
        "3. 用中文分点陈述，最多 3 个要点，总字数不超过 250 字",
      ]
        .filter(Boolean)
        .join("\n\n");

      draft = extractText(await model.invoke(prompt)).trim();
    } catch (error) {
      console.warn(`[draftNode] 模型调用失败，改用规则草稿：${describeError(error)}`);
    }
  }

  if (!draft) draft = fallbackDraft(state.question, revisions, findings, feedback);

  emit(config, "draftNode", `草稿完成（${draft.length} 字）`);

  return { draft, revisions };
}

/** 模型不可用时的规则草稿：保留来源，且把审批反馈写进正文 */
function fallbackDraft(
  question: string,
  revisions: number,
  findings: Finding[],
  feedback: string,
): string {
  const lines: string[] = [`关于「${question}」，基于本地知识库整理如下：`];

  if (feedback) lines.push(`（已按第 ${revisions} 版审批反馈修订：${feedback}）`);

  if (findings.length === 0) {
    lines.push("知识库中未找到相关依据。");
  } else {
    findings.forEach((finding, index) => {
      lines.push(`${index + 1}. ${finding.text} ${describeFinding(finding)}`);
    });
  }

  if (feedback) {
    const example = findings[0];
    lines.push(
      example
        ? `补充一个具体例子：${example.text.slice(0, 120)} ${describeFinding(example)}`
        : "补充一个具体例子：知识库中未找到相关依据，不编造内容。",
    );
  }

  return lines.join("\n");
}

/** review：自检覆盖度；revisions 达到 2 时强制通过，避免死循环 */
async function reviewNode(
  state: ResearchStateType,
  config: LangGraphRunnableConfig,
): Promise<Partial<ResearchStateType>> {
  const revisions = state.revisions ?? 0;
  const findings = state.findings ?? [];

  emit(config, "review", `自检第 ${revisions} 版草稿`);

  if (revisions >= 2) {
    emit(config, "review", "已达最大改稿次数，强制通过");
    return { reviewPassed: true, missing: state.missing ?? [], steps: ["review:force-pass"] };
  }

  let review: { passed: boolean; missing: string[] } | null = null;
  const model = tryCreateModel();

  if (model) {
    try {
      const reviewer = model.withStructuredOutput(ReviewSchema);
      review = await reviewer.invoke(
        [
          "你是审稿人。判断下面的草稿是否回答了问题，并且每条结论都带来源标注。",
          `问题：${state.question}`,
          `草稿：\n${state.draft}`,
          `草稿引用的来源：${formatSources(findings)}`,
          "missing 列出尚未覆盖的检查项；没有遗漏时返回空数组。",
        ].join("\n\n"),
      );
    } catch (error) {
      console.warn(`[review] 模型调用失败，改用规则自检：${describeError(error)}`);
    }
  }

  if (!review) {
    const passed = findings.length > 0;
    review = {
      passed,
      missing: passed ? [] : ["知识库中没有找到可引用的依据"],
    };
  }

  emit(
    config,
    "review",
    review.passed ? "自检通过" : `自检未通过，缺口 ${review.missing.length} 项`,
  );

  return { reviewPassed: review.passed, missing: review.missing, steps: ["review"] };
}

/** approval：interrupt 暂停，等待人工审批；恢复值用 zod 校验 */
function approvalNode(
  state: ResearchStateType,
  config: LangGraphRunnableConfig,
): Partial<ResearchStateType> {
  emit(config, "approval", "等待人工审批");

  const request: ApprovalRequest = {
    type: "approval_request",
    question: state.question,
    draft: state.draft ?? "",
    missing: state.missing ?? [],
  };

  // 恢复时 interrupt 返回 Command({ resume }) 里传入的值
  const rawResume = interrupt<ApprovalRequest, unknown>(request);
  const parsed = ApprovalResumeSchema.safeParse(rawResume);

  if (!parsed.success) {
    throw new Error(
      `审批恢复值不合法：${parsed.error.message}\n` +
        `期望格式：{ decision: "approve" | "reject", feedback?: string }`,
    );
  }

  const resume: ApprovalResume = parsed.data;

  return {
    approved: resume.decision === "approve",
    feedback: resume.feedback ?? "",
    steps: ["approval"],
  };
}

/** finalize：输出最终稿，保留引用与未覆盖项 */
function finalizeNode(
  state: ResearchStateType,
  config: LangGraphRunnableConfig,
): Partial<ResearchStateType> {
  emit(config, "finalize", "生成最终稿");

  const findings = state.findings ?? [];
  const missing = state.missing ?? [];
  const sources = Array.from(new Set(findings.map((finding) => `${finding.source}#${finding.chunkIndex}`)));

  const parts: string[] = [state.draft ?? ""];

  if (missing.length > 0) {
    parts.push(`未覆盖的检查项：${missing.join("；")}`);
  }

  parts.push(
    sources.length > 0
      ? `参考来源：\n${sources.map((source) => `- ${source}`).join("\n")}`
      : "参考来源：知识库中未找到相关依据。",
  );

  return { finalAnswer: parts.filter(Boolean).join("\n\n"), steps: ["finalize"] };
}

// ─────────────────────────────────────────────
// 路由
// ─────────────────────────────────────────────

/** 每个子问题发一个 Send，并行进入 research 子图 */
function dispatchQueries(state: ResearchStateType): Send[] {
  const queries = state.queries ?? [];
  return queries.map((query) => new Send("research", { query }));
}

/** 自检通过 → approval；不通过 → 回到 draftNode */
function routeAfterReview(state: ResearchStateType): "approval" | "draftNode" {
  return state.reviewPassed ? "approval" : "draftNode";
}

/** 审批通过 → finalize；拒绝 → 带 feedback 回到 draftNode */
function routeAfterApproval(state: ResearchStateType): "finalize" | "draftNode" {
  return state.approved ? "finalize" : "draftNode";
}

// ─────────────────────────────────────────────
// 组装图
// ─────────────────────────────────────────────

export function createResearchGraph(checkpointer: BaseCheckpointSaver) {
  return new StateGraph(ResearchState)
    .addNode("plan", planNode)
    .addNode("research", researchSubgraph)
    .addNode("draftNode", draftNode)
    .addNode("review", reviewNode)
    .addNode("approval", approvalNode)
    .addNode("finalize", finalizeNode)
    .addEdge(START, "plan")
    .addConditionalEdges("plan", dispatchQueries, ["research"])
    .addEdge("research", "draftNode")
    .addEdge("draftNode", "review")
    .addConditionalEdges("review", routeAfterReview, {
      approval: "approval",
      draftNode: "draftNode",
    })
    .addConditionalEdges("approval", routeAfterApproval, {
      finalize: "finalize",
      draftNode: "draftNode",
    })
    .addEdge("finalize", END)
    .compile({ checkpointer });
}

export type { ApprovalRequest };
