/**
 * 主图与 research 子图的状态定义。
 * findings / steps 使用 reducer 累积；findings 以 source#chunkIndex 去重。
 */

import { z } from "zod";
import { withLangGraph } from "@langchain/langgraph/zod";

export const FindingSchema = z.object({
  /** 片段正文（已压缩） */
  text: z.string(),
  /** 来源文件名 */
  source: z.string(),
  /** 来源段落序号 */
  chunkIndex: z.number(),
});

export type Finding = z.infer<typeof FindingSchema>;

function findingKey(finding: Finding): string {
  return `${finding.source}#${finding.chunkIndex}`;
}

/** 去重累积：同一段落被多个并行分支命中时只保留一条 */
function mergeFindings(left: Finding[], right: Finding[]): Finding[] {
  const merged = new Map<string, Finding>();

  for (const finding of [...left, ...right]) {
    merged.set(findingKey(finding), finding);
  }

  return Array.from(merged.values());
}

/** 执行轨迹去重累积，避免并行分支重复记录同名步骤 */
function mergeSteps(left: string[], right: string[]): string[] {
  return Array.from(new Set([...left, ...right]));
}

export const ResearchState = z.object({
  /** 用户原始问题 */
  question: z.string(),
  /** plan 拆出的检索子问题 */
  queries: z.array(z.string()).default([]),
  /** 并行检索结果，去重累积 */
  findings: withLangGraph(z.array(FindingSchema), {
    reducer: { fn: mergeFindings },
    default: () => [],
  }),
  /** 当前草稿 */
  draft: z.string().default(""),
  /** 自检是否通过 */
  reviewPassed: z.boolean().default(false),
  /** 自检发现的缺口 */
  missing: z.array(z.string()).default([]),
  /** 草稿版本数 */
  revisions: z.number().default(0),
  /** 人工审批是否通过 */
  approved: z.boolean().default(false),
  /** 审批反馈 */
  feedback: z.string().default(""),
  /** 最终稿 */
  finalAnswer: z.string().default(""),
  /** 节点执行轨迹 */
  steps: withLangGraph(z.array(z.string()), {
    reducer: { fn: mergeSteps },
    default: () => [],
  }),
});

export type ResearchStateType = z.infer<typeof ResearchState>;

/** research 子图状态：只接收单个 query，并写回 findings / steps */
export const ResearchSubgraphState = z.object({
  /** Send 传入的单个检索子问题 */
  query: z.string(),
  /** 子图内部检索命中，不写回父图 */
  hits: z.array(FindingSchema).default([]),
  /** 压缩后的片段，与父图共享同名字段 */
  findings: z.array(FindingSchema).default([]),
  /** 与父图共享的执行轨迹 */
  steps: withLangGraph(z.array(z.string()), {
    reducer: { fn: mergeSteps },
    default: () => [],
  }),
});

export type ResearchSubgraphStateType = z.infer<typeof ResearchSubgraphState>;
