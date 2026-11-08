/**
 * 从流式分片中提取正文文本
 *
 * LangChain v1 的 streamMode: "messages" 每产出一个 chunk，
 * chunk.content 的形态有两种：
 *
 *   1. string —— 纯文本模型的输出，直接返回
 *      例子："RAG 是检索增强生成..."
 *
 *   2. ContentBlock[] —— 多模态模型或推理型模型的输出，
 *      每个 block 有 type 字段，可能是：
 *        "text"        —— 正文（我们要的）
 *        "tool_use"    —— 工具调用（跳过，工具执行结果在另一条消息里）
 *        "tool_result" —— 工具结果（也跳过，不该显示在助手回答里）
 *        "reasoning"   —— 模型内部推理过程（跳过，不应该暴露给用户）
 *        "image_url"   —— 图片（跳过）
 *      只拼接 type === "text" 且 text 字段是 string 的块。
 *
 * 为什么不直接 JSON.stringify(content) 然后把所有东西都显示出来：
 *   tool_use 块会包含工具参数，reasoning 块是模型的思维链，
 *   这两种都不该暴露给用户；而且 JSON.stringify 出来的字符串
 *   会是一堆 {"type":"text","text":"..."} 形式，非常难看。
 *
 * 参数 chunk 类型是 unknown：上游流可能产出各种形状的对象，
 * 我们不假设它有 content 字段，所有判断都在运行时做。
 */
export function extractText(chunk: unknown): string {
  // 基本防御：null / undefined / 非对象 / 没有 content 属性都直接返回空串
  if (!chunk || typeof chunk !== "object" || !("content" in chunk)) {
    return "";
  }

  const content = (chunk as { content?: unknown }).content;

  // 路径 1：纯字符串 —— 最常见
  if (typeof content === "string") {
    return content;
  }

  // 路径 2：ContentBlock[] —— 多模态 / 推理型模型的输出
  if (!Array.isArray(content)) {
    return "";
  }

  let text = "";
  for (const block of content as Array<{ type?: unknown; text?: unknown }>) {
    // 只取 type === "text" 且 text 字段是 string 的块
    // （block.text 可能是 string 以外的类型，比如 image_url 的 url 是 string 但 type 不是 text）
    if (block.type === "text" && typeof block.text === "string") {
      text += block.text;
    }
  }
  return text;
}
