# Day 7 提示词：RAG Agent（检索工具化）

> 用法：在项目根目录开启新会话，把本文件内容整段发给 AI。这是一个独立任务，不依赖其他 prompt 文件。

## 背景

你是一名资深 TypeScript 工程师，带我学习 LangChain.js v1。项目根目录就是当前工作目录，Day 1～6 已完成：Agent、工具、记忆、RAG 入库与相似度检索。

今天把检索封装成工具，交给 `createAgent` 使用，让 Agent 自己决定“什么时候该查知识库”。今天不做 middleware、不做前端。

## 硬性约束：独立日代码

- 只新建 `src/day7/` 下的文件。
- 允许在根 `package.json` 的 `scripts` 中新增 `day7`，允许新增依赖；不得升级、降级或删除已有依赖，不得改动其他脚本。
- 不 import `src/shared`、`src/day1`～`src/day6`；把需要的代码和文档**复制**到 `src/day7/` 内再改。
- 不修改其他 day 的任何文件，不改根 `tsconfig.json`。

## 目标

做出一个能回答“基于我的文档”的 Agent：

- Agent 自己判断要不要调用检索工具
- 回答必须带来源引用 `[来源: 文件名#chunkIndex]`
- 知识库没有依据时，明确说“不知道”，不编造

## 开始前

先读：

1. `PLAN.md`
2. `src/day6/rag.ts`、`src/day6/ingest.ts`、`src/day6/model.ts`
3. `src/day4/agent.ts` 中 `createAgent` 的用法
4. `node_modules/@langchain/core/tools` 中 `tool()` 的类型定义

读完只借鉴思路，不要 import 这些文件。

## 任务

### 1. 复制基础代码

在 `src/day7/` 内建立独立副本：

- `src/day7/docs/`：复制 Day 6 的 3 篇 Markdown
- `src/day7/model.ts`：env 读取、`createEmbeddings()`、`createChatModel()`
- `src/day7/ingest.ts`：加载、切分、建库

要求：

- 不 import `src/day6`
- `createChatModel()` 返回 `initChatModel(...)`，配置与本项目现有的 OpenAI 兼容方式一致
- `ingest.ts` 暴露一个 `getVectorStore()`，重复调用时复用同一个实例，不要每次重新 embed

### 2. 检索工具

新建 `src/day7/retriever-tool.ts`：

- 用 `tool()` 定义 `search_knowledge_base`
- 参数：`{ query: string }`
- 内部调用 `vectorStore.similaritySearchWithScore(query, 4)`
- 返回格式化文本，每条包含：
  - 序号
  - `来源: <source>#<chunkIndex>`
  - 相似度分数（保留 3 位小数）
  - chunk 正文
- 没有结果时返回：`知识库中没有找到相关内容。`
- 工具内部用 `console.log` 打印命中的来源和分数，方便观察；返回给模型的内容保持干净

### 3. RAG Agent

新建 `src/day7/rag-agent.ts`：

- `const agent = createAgent({ model, tools: [searchTool], systemPrompt })`
- `systemPrompt` 必须包含这些规则：
  - 只依据检索结果回答
  - 每个结论后面标注 `[来源: 文件名#chunkIndex]`
  - 检索结果不足时回答“根据现有知识库无法回答”，不要补充常识
  - 可以用一次检索，不要为了凑引用反复调用
- 用 `agent.invoke({ messages: [new HumanMessage(question)] })` 调用
- 打印最终回答

### 4. CLI 演示

默认跑 4 个问题：

1. `RAG 的流程分哪几步？`（应命中 rag.md）
2. `createAgent 和 middleware 是什么关系？`（应命中 agents.md）
3. `checkpointer 的作用是什么？`（应命中 agents.md）
4. `LangChain 支持哪些向量数据库？`（知识库里没有，应该明确说不知道）

支持：

```bash
npm run day7 -- "自定义问题"
```

### 5. 脚本

在 `package.json` 增加：

```json
"day7": "tsx src/day7/rag-agent.ts"
```

## 约束

- TypeScript strict，相对导入写 `.js` 后缀
- 不接真实外部搜索 API
- 不做 middleware、不做前端、不做持久化
- 不 import 其他 day 目录
- 注释用中文

## 验收

```bash
npm run typecheck
npm run day7
```

通过标准：

- 前 3 个问题能命中对应文档，并带 `[来源: ...]`
- 第 4 个问题明确说不知道，没有编造
- 工具日志里能看到命中的 chunk 和分数
- 重复运行不会重复 embed（同一进程内只建一次库）
- 代码中没有 import 其他 day 目录或 `src/shared`

## 汇报

完成后告诉我：

1. 新增/修改了哪些文件
2. 每个问题的工具调用轨迹和引用来源
3. 第 4 个问题 Agent 的实际回答
4. 检索工具的 description 怎么写，为什么这样写
5. 和 Day 3 手动工具循环相比，RAG Agent 的调用链有什么不同
