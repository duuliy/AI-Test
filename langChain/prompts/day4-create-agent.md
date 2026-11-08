# Day 4 提示词：createAgent

> 用法：在项目根目录开启新会话，把本文件内容整段发给 AI。这是一个独立任务，不依赖其他 prompt 文件。

## 背景

你是一名资深 TypeScript 工程师，带我学习 LangChain.js v1。项目根目录就是当前工作目录，已有：

- `package.json`：`langchain@1.5.18`、`@langchain/core`、`@langchain/openai`、`zod`、`tsx`
- `tsconfig.json`：strict + NodeNext，相对导入必须带 `.js` 后缀
- Day 1～3：流式对话、结构化输出、手动 tool calling 循环
- `.env`：`OPENAI_API_KEY`、`OPENAI_BASE_URL`、`OPENAI_MODEL`

Day 3 已经手写过“模型调用工具再总结”的循环。今天用 `createAgent` 替换它，重点学 `systemPrompt`、`responseFormat` 和 `stream`。

## 目标

用 `createAgent` 搭出一个能自主调用工具的 Agent，并掌握：

- `systemPrompt` 如何约束行为
- `responseFormat` 如何让最终答复结构化
- `stream` 的 `messages` 和 `updates` 两种模式分别输出什么

## 开始前

先读：

1. `PLAN.md`
2. `src/day3/tools.ts` 和 `src/day3/run-tools.ts`
3. `src/day2/structured.ts`
4. `node_modules/langchain/dist/agents/types.d.ts` 中 `CreateAgentParams`
5. `node_modules/langchain/dist/agents/ReactAgent.d.ts` 中 `invoke`、`stream` 的签名和注释
6. `node_modules/@langchain/langgraph/dist/pregel/types.d.ts` 中 `StreamMode` 的取值

API 不确定时以本地类型定义和官方文档为准。不要使用 `AgentExecutor`、`initializeAgentExecutorWithOptions` 等旧 API。

## 任务

### 1. 复用工具

- 如果 `src/day3/tools.ts` 存在，直接 `import { tools } from "../day3/tools.js"`
- 如果不存在，把三个工具复制到 `src/day4/tools.ts`，并在汇报里说明原因

不要修改 Day 3 的文件。

### 2. 基础 Agent

新建 `src/day4/agent.ts`：

- `import { createAgent } from "langchain"`
- 模型复用 `src/shared/model.ts` 的 `createModel()`
- 用 `createAgent({ model, tools, systemPrompt })`
- `systemPrompt` 要求：
  - 用中文回答
  - 先判断是否需要工具，需要就调用，不要凭空编造
  - 工具结果要转述成自然语言，不要原样贴 JSON
  - 不知道就明确说不知道
- 用 `agent.invoke({ messages: [new HumanMessage(question)] })` 调用
- 打印最终 `AIMessage` 的文本，以及本轮产生了多少次工具调用
  （从返回的 `messages` 里筛选 `AIMessage`，统计其 `tool_calls` 总数，不要自己维护计数器）

### 3. responseFormat

再创建一个带结构化输出的 Agent：

- 用 Zod 定义最终答复结构：`{ answer: string, usedTools: string[], confidence: "low" | "medium" | "high" }`
- 通过 `createAgent({ model, tools, systemPrompt, responseFormat: schema })` 配置（当前版本允许直接传 Zod schema）
- 调用后打印结构化结果
- 结构化结果在返回值的 `structuredResponse` 字段上；只有配置了 `responseFormat` 时该字段才存在，字段名以本地类型为准，不要猜

### 4. 流式输出

分别演示两种 `streamMode`，模式通过 **config** 传入，不是第二个位置参数：

```ts
const stream = await agent.stream(
  { messages: [new HumanMessage(question)] },
  { streamMode: "messages" },
);
```

- `"messages"`：逐段打印 AI 文本，确认是增量输出
- `"updates"`：打印每一步状态更新，观察工具调用发生在哪一步

当前安装版本（`@langchain/langgraph@1.5.1`）的合法取值是
`"values" | "updates" | "debug" | "messages" | "checkpoints" | "tasks" | "custom" | "tools"`。
今天只用 `"messages"` 和 `"updates"`，不要在代码里写死其它模式。

用注释说明两种模式返回的数据形状有什么不同。

### 5. CLI

- 默认问题：`现在上海几点？再算一下 42 * 17`
- 支持 `npm run day4 -- "自定义问题"`
- 输出顺序：问题 → 工具调用轨迹 → 流式文本 → 结构化结果

### 6. 脚本

在 `package.json` 增加：

```json
"day4": "tsx src/day4/agent.ts"
```

## 约束

- 必须使用 `langchain` 的 `createAgent`
- 今天不要加 `checkpointer` 或 `thread_id`，记忆是 Day 5 的内容
- 不要自己再写一遍 tool calling 循环
- 不加 RAG、不加持久化
- 不修改 Day 1～3 的文件
- TypeScript strict，相对导入写 `.js` 后缀
- 注释用中文

## 验收

依次执行：

```bash
npm run typecheck
npm run day4
```

通过标准：

- Agent 能自主选中正确工具
- 流式文本是逐步出现的，不是最后一次性打印
- `responseFormat` 的结构化结果字段完整
- 不传 `responseFormat` 时仍能正常返回自然语言，且返回类型里没有 `structuredResponse` 报错
- 代码中没有旧版 Agent API

## 汇报

完成后告诉我：

1. 新增/修改了哪些文件
2. `createAgent` 的完整配置项和你实际用到的字段
3. `"messages"` 与 `"updates"` 两种流式模式的输出差异
4. 结构化结果是从哪个字段拿到的
5. 和 Day 3 手动循环相比，`createAgent` 省掉了哪些代码
