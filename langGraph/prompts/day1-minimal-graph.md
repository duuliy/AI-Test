# Day 1 提示词：环境与最小状态图

> 用法：在项目根目录开启新会话，把本文件内容整段发给 AI。这是一个独立任务。

## 背景

你是一名资深 TypeScript 工程师，带我学习 LangGraph.js（`@langchain/langgraph`）。项目根目录就是当前工作目录，已有 `PLAN.md`，`src/` 还没有任何代码。

技术约定：

- Node 20+、TypeScript strict、用 `tsx` 直接运行 TS
- 模型走 OpenAI 兼容接口，`.env` 里已有 `OPENAI_API_KEY`、`OPENAI_BASE_URL`、`OPENAI_MODEL`
- 使用 LangGraph v1 新 API，优先 `StateSchema` 写法，不使用旧的 `Annotation` 风格
- 我熟悉 TypeScript / Node.js，不需要解释 JS 基础概念

## 目标

从零搭出项目骨架，并写出第一张 `StateGraph`，掌握三件事：

1. `new StateSchema({...})` 怎么定义状态，节点为什么只返回**部分更新**
2. `StateGraph` 的节点、边、`START` / `END`，以及 `compile()` 的作用
3. `invoke` 与 `stream({ streamMode: "updates" })` 分别拿到什么

## 开始前

1. 先 `ls` 查看当前目录，**不要覆盖已有文件**
2. 检查 Node 版本是否 >= 20；不是则提示切换，不要擅自改系统环境
3. 先读：
   - `PLAN.md`
   - `node_modules/@langchain/langgraph/dist/state/schema.d.ts` 中 `StateSchema` 的构造和字段说明
   - `node_modules/@langchain/langgraph/dist/state/values/reduced.d.ts` 中 `ReducedValue` 的参数
   - `node_modules/@langchain/langgraph/dist/graph/state.d.ts` 中 `StateGraph` 的 `addNode` / `addEdge` / `compile`
   - `node_modules/@langchain/langgraph/dist/pregel/types.d.ts` 中 `StreamMode` 的取值
4. 不要提前实现 Day 2 及以后的能力

API 不确定时以本地类型定义和官方文档为准，不要凭记忆写参数。

## 任务

### 1. 工程文件

创建 / 补齐：

- `package.json`：依赖 `@langchain/langgraph`、`@langchain/core`、`@langchain/openai`、`zod`；dev 依赖 `tsx`、`typescript`、`@types/node`
- `tsconfig.json`：`strict`、`module` / `moduleResolution` 用 NodeNext、`target` ES2022
- `.env.example`：三个变量留占位值
- `.gitignore`：忽略 `node_modules`、`.env`、`dist`
- `scripts`：`day1` → `tsx src/day1/graph.ts`，`typecheck` → `tsc --noEmit`

不要提交真实 key。

### 2. `src/day1/model.ts`

- `loadEnv()`：用 `process.loadEnvFile()`，`.env` 不存在时忽略（ENOENT），其他错误抛出
- `readConfig()`：校验三个环境变量，缺失时一次性列出全部缺失项、中文提示、`exit(1)`
- `createChatModel()`：`initChatModel`，`temperature: 0.2`
- `describeError(error)`：把 401/403、404、429、5xx、DNS、连接拒绝、超时翻译成中文
- `extractText(message)`：兼容 `content` 为 string 或 ContentBlock[]，只取 `type === "text"` 的块

### 3. `src/day1/graph.ts`

状态用 `new StateSchema({...})` 定义：

- `question: z.string()`
- `category: z.string().default("unknown")`
- `answer: z.string().default("")`
- `steps`：用 `ReducedValue`，输入是字符串，累积成字符串数组

三个节点：

1. `classify`：按关键词把问题分成 `time` / `rag` / `general`，返回 `{ category, steps: "classify" }`
2. `answer`：
   - `time`：用本地时间直接回答
   - `rag`：用一段固定文字解释 RAG 流程
   - `general`：调用模型回答
   - 返回 `{ answer, steps: "answer" }`
3. `review`：检查 `answer` 非空；为空则填入兜底文案；返回 `{ steps: "review" }`

组装：

- `new StateGraph(GraphState)`
- `START → classify → answer → review → END`
- `compile()` 后分别用三个问题 `invoke`：`现在几点？`、`RAG 是什么？`、`用一句话解释 Agent`
- 每次打印 `question`、`category`、`answer`、`steps`

再用其中一个问题跑一次 `stream({ streamMode: "updates" })`，打印每个节点的名字和返回的更新字段。

### 4. 脚本

在 `package.json` 增加：

```json
"day1": "tsx src/day1/graph.ts",
"typecheck": "tsc --noEmit"
```

## 约束

- 今天不使用 `createAgent`，也不做工具调用
- 不做条件边、循环、checkpointer、中断，这些是后续几天
- 不新建 `src/shared`，env 读取和模型初始化都放在 `src/day1/` 内
- 不修改 `PLAN.md`
- TypeScript strict，相对导入写 `.js` 后缀
- 注释用中文

## 验收

```bash
npm run typecheck
npm run day1
```

通过标准：

- `typecheck` 通过
- 三个问题都打印出完整字段，`steps` 顺序是 `classify → answer → review`
- `steps` 是累积数组，不是被覆盖成单个字符串
- `updates` 流每次只出现一个节点名，能看出执行顺序
- 节点名和状态字段没有同名冲突

## 讲解要求

每完成一段，用中文说明“为什么这么写”，重点讲：

- 节点接收完整 State，为什么只返回部分更新
- `compile()` 到底校验了什么
- `StateGraph` 和 LangChain 的 `createAgent` 是什么关系

最后给 3 道自测题。

## 汇报

完成后告诉我：

1. 新增了哪些文件
2. 状态里有哪几个字段，各自用的是什么 schema 或 reducer
3. 三个问题的分类和最终 `steps`
4. `updates` 流里看到的节点顺序
5. 用一句话说明 `StateGraph` 和 `createAgent` 的关系
