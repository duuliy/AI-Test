/**
 * Day 7 · 检索工具
 *
 * 把向量检索封装成一个标准工具，交给 createAgent 使用。
 * 工具内部负责检索和日志，返回给模型的是干净的格式化文本。
 * 阅读顺序建议排第三：重点看 description 和返回格式。
 */
import { tool } from "@langchain/core/tools"; // 把普通函数包装成模型可调用的工具
import { z } from "zod"; // 用 zod 定义工具参数的结构
import { getVectorStore } from "./ingest.js"; // 获取（必要时懒建）内存向量库

/**
 * 每次检索返回的 chunk 数量。
 * 取 4 而不是 3：Agent 需要多一点上下文来判断问题是否真的有依据，
 * 同时又不至于把无关内容塞满上下文窗口。
 */
const TOP_K = 4; // 每次取相似度最高的 4 个片段

// tool() 的第一个参数是执行函数，第二个参数是给模型看的元数据
export const searchKnowledgeBaseTool = tool(
  async ({ query }) => {
    // 第一次调用会触发建库，之后复用同一个 MemoryVectorStore 实例
    const store = await getVectorStore(); // 拿到已经建好的向量库
    // 相比 similaritySearch，这里带分数返回，便于判断“命中”还是“勉强相关”
    const results = await store.similaritySearchWithScore(query, TOP_K); // 返回 [Document, score] 数组

    // 空库或没有命中时给模型一个明确的“无内容”信号
    if (results.length === 0) {
      console.log(`[检索] 「${query}」没有命中任何 chunk`); // 日志里记下这次空检索
      return "知识库中没有找到相关内容。"; // 固定文案，方便模型识别并拒答
    }

    const lines: string[] = []; // 逐行拼接返回给模型的文本
    // index 是排名（从 0 开始），doc 是片段，score 是相似度
    for (const [index, [doc, score]] of results.entries()) {
      const source = String(doc.metadata.source ?? "unknown"); // 文件名，缺失时用 unknown
      const chunkIndex = String(doc.metadata.chunkIndex ?? "?"); // 块序号，缺失时用问号
      // 日志只给人看：命中来源和分数方便观察检索质量；
      // 这些信息不会写进返回值，避免干扰模型对正文的判断。
      console.log(
        `[检索] ${index + 1}. ${source}#${chunkIndex} 相似度 ${score.toFixed(3)}`, // 序号从 1 开始，分数保留 3 位
      );

      // 返回给模型的格式：序号 + 来源 + 分数 + 正文。
      // 来源固定写成 文件名#chunkIndex，模型可以原样抄进 [来源: ...] 引用。
      lines.push(`${index + 1}. 来源: ${source}#${chunkIndex}（相似度 ${score.toFixed(3)}）`); // 每个片段的来源行
      lines.push(doc.pageContent.trim()); // 片段的原始正文
      lines.push(""); // 空行分隔下一个片段，便于模型阅读
    }

    return lines.join("\n").trim(); // 用换行拼成最终文本，去掉首尾多余空行
  },
  {
    name: "search_knowledge_base", // 工具名，必须是模型能识别的英文标识
    // description 是写给模型看的“使用说明”，直接决定它什么时候调用这个工具；
    // 所以这里把知识库范围、返回格式、无依据时的处理都写清楚。
    description:
      "检索本地知识库，知识库包含 3 篇文档：LangChain v1 基础概念（langchain-basics.md）、RAG 流程（rag.md）、createAgent/middleware/checkpointer（agents.md）。" + // 先说明知识库覆盖范围
      "当问题涉及这些主题、需要事实依据时调用；返回按相似度排序的片段，每段带来源和 chunk 编号。" + // 说明何时调用、返回什么
      "如果检索结果与问题无关，说明知识库没有依据，应直接回答不知道，不要调用常识补全。", // 明确无依据时的行为
    schema: z.object({
      query: z
        .string() // 参数必须是字符串
        .min(1) // 不允许空字符串
        .describe("检索用的问题或关键词，尽量具体，例如“checkpointer 的作用”"), // 告诉模型该怎么填这个参数
    }),
  },
);
