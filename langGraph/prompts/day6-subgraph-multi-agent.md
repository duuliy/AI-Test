# Day 6 提示词：子图、并行与多 Agent

> 用法：在项目根目录开启新会话，把本文件内容整段发给 AI。这是一个独立任务，不依赖其他 prompt 文件。

## 背景

你是一名资深 TypeScript 工程师，带我学习 LangGraph.js v1。项目根目录就是当前工作目录，Day 1～5 已完成：状态图、reducer、条件边、持久化、中断审批与流式。

今天的重点是把一张大图拆开：子图负责独立流程，`Send` 负责并行分发，supervisor 负责多角色调度。

## 硬性约束：独立日代码

- 只新建 `src/day6/` 下的文件
- 允许在根 `package.json` 的 `scripts` 中新增 `day6`、`day6:send`、`day6:supervisor`，允许新增依赖；不得升级、降级或删除已有依赖，不得改动其他脚本
- 不 import `src/shared`、`src/day1`～`src/day5`；env 读取和模型初始化复制到 `src/day6/` 内
- 不修改其他 day 的任何文件，不改根 `tsconfig.json` 和 `PLAN.md`

## 目标

1. 把一个编译好的子图当作父图节点，理解父子状态的共享与隔离
2. 用 `Send` 把列表动态分发给同一个节点并行执行，再用 reducer 汇总
3. 手写一个 supervisor 循环：路由 → worker → 回到路由 → 结束
4. 能判断什么时候该拆子图、什么时候一张图就够

## 开始前

先读：

1. `PLAN.md`
2. `src/day3/react-graph.ts` 中条件边与循环的写法
3. `src/day2/reducers.ts` 中 `ReducedValue` 的累积写法
4. `node_modules/@langchain/langgraph/dist/graph/state.d.ts` 中 `addNode` 支持的节点类型（是否接受已编译图）
5. `node_modules/@langchain/langgraph/dist/constants.d.ts` 中 `Send` 的构造参数
6. `node_modules/@langchain/langgraph/dist/graph/graph.d.ts` 中 `addConditionalEdges`
7. `node_modules/@langchain/langgraph/dist/pregel/types.d.ts` 中 `recursionLimit`

不要把官方 supervisor 包硬塞进来；手写路由更容易看清机制。如果确实要用包，先确认当前版本是否提供并在汇报里说明。

## 任务

### 1. 配置与本地文档

新建 `src/day6/model.ts`，内容同 Day 1 的 `model.ts`（独立复制）。

新建 `src/day6/docs.ts`：

- 三篇短文档对象：`{ id, title, content }`，主题分别是 LangGraph、RAG、前端流式
- 关键词检索函数：按查询词命中数打分，返回前两条
- 不要做 embedding，这一步只是为了给子图提供可检索的内容，RAG 已经在 LangChain 周学过

### 2. 子图

新建 `src/day6/subgraph.ts`：

- 子图状态：`query: z.string()`、`findings: z.string().default("")`、`steps`（`ReducedValue` 累积）
- 节点：
  - `search`：调用 `docs.ts` 的检索，返回 `{ findings, steps: "subgraph:search" }`
  - `summarize`：把检索结果压成两句话，返回 `{ findings, steps: "subgraph:summarize" }`
- 子图：`START → search → summarize → END`，`compile()` 后不接 checkpointer
- 父图状态：`question: z.string()`、`findings: z.string().default("")`、`answer: z.string().default("")`、`steps`（`ReducedValue`）
- 父图：`START → plan → research(子图) → answer → END`
  - `plan` 只负责把 `question` 整理成检索词
  - `research` 直接挂编译后的子图
  - `answer` 基于 `findings` 生成最终回答
- 打印父子图的状态差异，说明哪些字段共享、哪些字段只在子图内部存在

### 3. `Send` 并行

新建 `src/day6/send.ts`：

- 父图状态：`topic: z.string()`、`queries: z.array(z.string()).default([])`、`findings`（`ReducedValue` 累积并去重）、`summary: z.string().default("")`
- `plan` 节点：把 `topic` 拆成 3 个检索子问题，返回 `{ queries }`
- `researchOne` 节点：
  - 接收单个 `query`
  - 开始时打印时间和参数，结束时打印耗时，可加 200ms 延迟模拟检索
  - 返回 `{ findings: "..." }`
- 条件边路由：把 `state.queries.map((q) => new Send("researchOne", { query: q }))` 返回给图
  - 返回数组还是 `Command` 的 `goto`，以当前类型定义为准
- `summarize` 节点：读取汇总后的 `findings`，生成一段总结
- 图：`START → plan → (Send ×3) → researchOne → summarize → END`
- 输出要能证明三个分支是并行执行的：三次开始时间接近，总耗时远小于串行之和

### 4. 手写 supervisor

新建 `src/day6/supervisor.ts`：

- 状态：`task: z.string()`、`next: z.enum(["research", "write", "finish"]).default("research")`、`notes`（`ReducedValue` 累积）、`answer: z.string().default("")`、`hops: z.number().default(0)`
- `supervisor` 节点：
  - 用 `withStructuredOutput` 读取 `task` 和已有 `notes`，决定下一步：`research` / `write` / `finish`
  - 返回 `{ next, hops + 1 }`，并打印决策和理由
  - `hops` 超过 5 时强制 `finish`，避免死循环
- `research` 节点：调用本地文档检索，把结果追加到 `notes`
- `write` 节点：根据 `notes` 生成最终回答，返回 `{ answer }`
- 条件边：`supervisor` 按 `next` 指向 `research` / `write` / `END`
- `research`、`write` 都指回 `supervisor`
- 传入 `recursionLimit` 作为第二道保护
- 用 `"用 LangGraph 和 RAG 做一个带引用的问答助手"` 作为 `task`

### 5. 脚本

在 `package.json` 增加：

```json
"day6": "tsx src/day6/subgraph.ts",
"day6:send": "tsx src/day6/send.ts",
"day6:supervisor": "tsx src/day6/supervisor.ts"
```

## 约束

- 不安装 `langgraph-supervisor` 之类的包，除非先说明必要性
- 不做真实检索服务、不做 embedding、不做前端
- 不做持久化与审批，这些已在 Day 4～5 验证过
- 不修改 Day 1～5 的文件
- TypeScript strict，相对导入写 `.js` 后缀
- 注释用中文

## 验收

```bash
npm run typecheck
npm run day6
npm run day6:send
npm run day6:supervisor
```

通过标准：

- 子图作为节点能跑通，父图输出包含子图产出的内容
- `Send` 三个分支都执行，`findings` 汇总完整，总耗时明显小于串行
- supervisor 至少出现一次 `research → supervisor → write → supervisor → finish`
- 所有循环都有 `hops` 或 `recursionLimit` 保护
- 代码中没有 import 其他 day 目录或 `src/shared`

## 汇报

完成后告诉我：

1. 新增了哪些文件
2. 父图与子图各自的状态字段，哪些共享
3. `Send` 的三个分支实际耗时
4. supervisor 的完整决策序列和理由
5. 什么情况下应该拆子图，什么情况下不该拆
6. `Send` 和普通条件边的区别
