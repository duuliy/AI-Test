# Day 10 提示词：LangSmith 追踪与 StateGraph

> 用法：在项目根目录开启新会话，把本文件内容整段发给 AI。这是一个独立任务，不依赖其他 prompt 文件。

## 背景

你是一名资深 TypeScript 工程师，带我学习 LangChain.js v1。项目根目录就是当前工作目录，Day 1～9 已完成：Agent、工具、记忆、RAG、middleware、Next.js 前端。

今天是第二周最后一天，做两件事：

1. 用 LangSmith 观察一次 Agent 调用的完整链路
2. 用 LangGraph 的 `StateGraph` 写一个最小状态图，理解节点、边和状态更新

今天不做多 Agent 协作，也不做自定义持久化。

## 硬性约束：独立日代码

- 只新建 `src/day10/` 下的文件。
- 允许在根 `package.json` 的 `scripts` 中新增 `day10` 和 `day10:graph`，允许新增依赖；不得升级、降级或删除已有依赖，不得改动其他脚本。
- 不 import `src/shared`、`src/day1`～`src/day9`；env 读取和模型初始化复制到 `src/day10/` 内。
- 不修改其他 day 的任何文件，不改根 `tsconfig.json`。
- 允许在根 `.env` **末尾追加** LangSmith 配置，但不得修改已有键；如果用户没有 key，代码必须能跳过追踪并正常运行。

## 目标

- 打开 LangSmith，能看到 Agent 的模型调用、工具调用和耗时
- 能跑通一个三节点 StateGraph，并打印状态变化
- 能说清 `StateGraph` 和 `createAgent` 的关系

## 开始前

先读：

1. `PLAN.md`
2. `src/day4/agent.ts` 中 `createAgent` 和 `stream` 的用法
3. `node_modules/@langchain/langgraph/dist/state/schema.d.ts` 中 `StateSchema`、`ReducedValue`
4. `node_modules/@langchain/langgraph/dist/graph/state.d.ts` 中 `StateGraph` 的构造和 `addNode` / `addEdge`
5. LangSmith 当前版本的 tracing 环境变量说明

API 不确定时以本地类型定义和官方文档为准。

## 任务

### 1. LangSmith 配置

在根 `.env` 末尾追加（已存在就跳过）：

```bash
LANGSMITH_TRACING=true
LANGSMITH_API_KEY=your_langsmith_key
LANGSMITH_PROJECT=langchain-learning
```

要求：

- 不覆盖、不删除已有键
- 代码同时兼容 `LANGSMITH_API_KEY` 和旧版 `LANGCHAIN_API_KEY`
- 没有 key 时打印“未配置 LangSmith，本次跳过追踪”，并继续执行示例，不要退出
- 不要打印完整 key，最多显示前 4 位

### 2. 独立配置

新建 `src/day10/model.ts`：

- `loadEnv()`
- `createChatModel()`，`temperature: 0.2`
- `describeError()`
- `isTracingEnabled()`：检查 `LANGSMITH_TRACING` / `LANGCHAIN_TRACING_V2` 和 key 是否齐全

### 3. LangSmith 追踪示例

新建 `src/day10/trace.ts`：

- 用 `createAgent` 创建一个带 `get_current_time` 工具的 Agent
- 连续问两个问题：
  1. `现在上海几点？`
  2. `那纽约呢？`
- 每个问题打印最终回答
- 结束时如果追踪开启，打印：
  - 项目名
  - `https://smith.langchain.com` 入口
  - 提示“在 Projects 里查看本次 run 的模型调用和工具调用”
- 不需要手动创建 tracer，依赖环境变量自动追踪；除非当前版本要求显式 tracer，再按类型定义处理

### 4. StateGraph 示例

新建 `src/day10/graph.ts`：

- 用 `new StateSchema({...})` 定义状态：
  - `question: z.string()`
  - `category: z.string().default("unknown")`
  - `answer: z.string().default("")`
  - `steps`: 用 `ReducedValue`，输入是字符串，累积成字符串数组
- 三个节点：
  1. `classify`：按关键词把问题分成 `time` / `rag` / `general`，返回 `{ category, steps: "classify" }`
  2. `answer`：
     - `time`：用本地时间直接回答
     - `rag`：用一段固定文字解释 RAG 流程
     - `general`：调用模型回答
     - 返回 `{ answer, steps: "answer" }`
  3. `review`：检查 `answer` 非空；为空则填入兜底文案；返回 `{ steps: "review" }`
- 用 `new StateGraph(GraphState)` 组装：
  - `START → classify → answer → review → END`
- `compile()` 后分别用三个问题 invoke：
  - `现在几点？`
  - `RAG 是什么？`
  - `用一句话解释 Agent`
- 打印每次的 `question`、`category`、`answer`、`steps`

### 5. 脚本

在 `package.json` 增加：

```json
"day10": "tsx src/day10/trace.ts",
"day10:graph": "tsx src/day10/graph.ts"
```

只新增这两条，不要改其他脚本。

## 约束

- 不做多 Agent、不做子图、不做自定义 checkpointer
- 不做 RAG 检索，`rag` 分类只返回固定说明
- 不把 LangSmith key 写进代码
- TypeScript strict，相对导入写 `.js` 后缀
- 注释用中文

## 验收

```bash
npm run typecheck
npm run day10
npm run day10:graph
```

通过标准：

- 没有 LangSmith key 时，`day10` 正常跑完并给出跳过提示
- 配置了 key 时，LangSmith 项目里能看到两次问题对应的 run，包含模型和工具调用
- `day10:graph` 打印三个问题的分类、回答和 `steps`，顺序是 `classify → answer → review`
- `steps` 是累积数组，不是被覆盖成单个字符串
- 代码中没有 import 其他 day 目录或 `src/shared`

## 汇报

完成后告诉我：

1. 新增/修改了哪些文件
2. LangSmith 是否启用，项目里看到了哪些节点
3. 三个问题的分类结果和 `steps`
4. `StateSchema` 的 `ReducedValue` 是怎么累积 `steps` 的
5. 用一句话说明 `StateGraph` 和 `createAgent` 的关系
