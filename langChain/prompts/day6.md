# Day 6 提示词：RAG 入库与检索

> 用法：在项目根目录开启新会话，把本文件内容整段发给 AI。这是一个独立任务，不依赖其他 prompt 文件。

## 背景

你是一名资深 TypeScript 工程师，带我学习 LangChain.js v1。项目根目录就是当前工作目录，Day 1～5 已完成：流式对话、结构化输出、工具调用、`createAgent`、checkpointer 记忆。

今天是第二周第一天，开始学 RAG。今天只做“文档 → 切分 → embedding → 内存向量库 → 相似度检索”，不要做 Agent，也不要把检索封装成工具，那是 Day 7 的内容。

## 硬性约束：独立日代码

- 只新建 `src/day6/` 下的文件。
- 允许在根 `package.json` 的 `scripts` 中新增 `day6`，允许新增依赖；不得升级、降级或删除已有依赖，不得改动其他脚本。
- 不 import `src/shared`、`src/day1`～`src/day5`；需要的 env 读取、模型初始化等代码复制到 `src/day6/` 内。
- 不修改其他 day 的任何文件，不改根 `tsconfig.json`。

## 目标

建立一个小型本地知识库，能回答：

- 一篇文档被切成了多少个 chunk
- 每个 chunk 的 metadata 长什么样
- 给定问题，相似度最高的 3 个 chunk 是哪些，分数是多少

## 开始前

先读：

1. `PLAN.md`
2. `src/day5/memory.ts`（只看 env 读取和模型初始化风格，不要复用文件）
3. `node_modules/@langchain/openai` 中 `OpenAIEmbeddings` 的类型定义
4. 本地 `@langchain/classic` 是否已安装；未安装再执行安装

API 不确定时以本地类型定义和官方文档为准。

## 任务

### 1. 安装依赖

```bash
npm i @langchain/textsplitters @langchain/classic
```

`@langchain/openai`、`@langchain/core` 已存在，不要重复安装或升级。

### 2. 本地文档

新建 `src/day6/docs/`，放 3 篇自己写的短 Markdown，每篇 500～800 字：

- `langchain-basics.md`：LangChain v1 的模型、消息、工具、Agent 概念
- `rag.md`：RAG 的加载、切分、embedding、检索流程
- `agents.md`：`createAgent`、middleware、checkpointer 的作用

不要复制外部文章，用你自己的话写，方便后续检索验证。

### 3. 独立配置

新建 `src/day6/model.ts`：

- `loadEnv()`：`process.loadEnvFile()`
- `createEmbeddings()`：校验 `OPENAI_API_KEY`、`OPENAI_BASE_URL`，返回 `OpenAIEmbeddings`
- embedding 模型优先读 `OPENAI_EMBEDDING_MODEL`，未设置时用 `"embedding-3"`，并在注释里说明这个默认值可按 provider 调整
- `describeError()`：中文错误提示，参考 Day 1 的写法

不要改 `.env`，也不要改 `.env.example`。需要时通过环境变量覆盖。

### 4. 加载与切分

新建 `src/day6/ingest.ts`：

- 用 `node:fs/promises` 读取 `src/day6/docs/*.md`
- 每篇转成 `Document`，metadata 至少包含 `source` 和 `title`
- 用 `@langchain/textsplitters` 的 `RecursiveCharacterTextSplitter` 切分：
  - `chunkSize: 400`
  - `chunkOverlap: 80`
- 每个 chunk 的 metadata 增加 `chunkIndex`
- 打印每篇文档的 chunk 数量，并预览第一个 chunk

### 5. 内存向量库

在 `src/day6/ingest.ts` 或单独文件里：

- 用 `MemoryVectorStore.fromDocuments(docs, embeddings)` 建库
- 用 `similaritySearchWithScore(query, 3)` 检索
- 打印：分数、`source`、`chunkIndex`、内容前 120 字

`MemoryVectorStore` 的导入路径以实际安装包为准，通常是 `@langchain/classic/vectorstores/memory`。

### 6. CLI

新建 `src/day6/rag.ts`：

- 默认问题：`RAG 的完整流程是什么？`
- 支持 `npm run day6 -- "问题"`
- 打印：文档数、chunk 总数、Top 3 检索结果

### 7. embedding 不可用时的兜底

当前 provider 可能没有 embedding 接口。要求：

- 先正常调用 `OpenAIEmbeddings`，失败时打印可读错误
- 如果设置 `USE_LOCAL_EMBEDDINGS=1`，改用本地 `LocalHashEmbeddings`
- 本地实现放在 `src/day6/hash-embeddings.ts`，继承 `@langchain/core/embeddings` 的 `Embeddings`，用 `node:crypto` 生成固定维度向量并归一化
- 注释说明：本地哈希只适合跑通流程，语义检索质量不如真实 embedding

不要静默 fallback，必须打印当前使用的是哪种 embedding。

### 8. 脚本

在 `package.json` 增加：

```json
"day6": "tsx src/day6/rag.ts"
```

## 约束

- TypeScript strict，相对导入写 `.js` 后缀
- 不接真实外部文档源，只用本地 3 篇文档
- 不做 Agent、不做工具、不做持久化向量库
- 不引入 `@langchain/community` 等额外大包
- 注释用中文

## 验收

```bash
npm run typecheck
npm run day6
USE_LOCAL_EMBEDDINGS=1 npm run day6
```

通过标准：

- 类型检查无错误
- 打印出 chunk 数量和 Top 3 结果
- 问 RAG 相关问题时，命中的 chunk 内容确实相关
- 换一个完全无关的问题，分数明显更低
- 代码中没有 import 其他 day 目录或 `src/shared`

## 汇报

完成后告诉我：

1. 新增/修改了哪些文件
2. 3 篇文档各切了多少 chunk
3. Top 3 检索结果和分数
4. 当前用的是真实 embedding 还是本地哈希，为什么
5. `chunkSize` / `chunkOverlap` 调整后结果有什么变化
