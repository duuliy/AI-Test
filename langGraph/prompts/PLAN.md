# LangGraph.js 一周学习计划

> 前置：已完成 LangChain.js 两周学习（`createAgent`、工具、记忆、RAG、middleware、Next.js 前端）。
> 这份计划只补 LangGraph 的编排能力，不重复学工具调用、结构化输出、RAG。
> 参考背景：[longchain.md](file:///Users/zhongyuhan/Desktop/aI-test/longChain/prompts/longchain.md)、[longchain-note.md](file:///Users/zhongyuhan/Desktop/aI-test/longChain/prompts/longchain-note.md)

## 技术栈

- Node 20+、TypeScript strict、`tsx`
- `@langchain/langgraph`、`@langchain/core`、`langchain`、`@langchain/openai`、`@langchain/langgraph-checkpoint-sqlite`、`zod`
- 模型复用现有 OpenAI 兼容配置（`OPENAI_API_KEY` / `OPENAI_BASE_URL` / `OPENAI_MODEL`）
- 每天 1 小时：10 分钟看类型定义和文档，35 分钟写代码，15 分钟记笔记

## 一周主线

```text
状态 → 节点 → 边 → 条件边 → 循环 → 持久化 → 中断审批 → 子图/多 Agent → 综合项目
```

LangGraph 解决的问题是：`createAgent` 只给你一个“模型 + 工具”的固定循环，一旦流程要分支、要暂停、要回滚、要多角色协作，就必须自己编排图。

## 总览

| Day | 主题 | 核心产出 |
|---|---|---|
| Day 1 | 最小状态图 | `classify → answer → review` 直线图 |
| Day 2 | 状态设计与 reducer | 累积字段、消息通道、并行合并 |
| Day 3 | 条件边与工具循环 | 手写 ReAct 图 + 循环保护 |
| Day 4 | 持久化与时间旅行 | SQLite checkpointer、线程隔离、断点重跑 |
| Day 5 | 中断与流式 | `interrupt` 审批、`Command` 恢复、custom 流 |
| Day 6 | 子图与多 Agent | 子图节点、`Send` 并行、supervisor |
| Day 7 | 综合项目 | 带审批的研究助手（CLI） |

## 每日提示词

每天开新会话时，把对应的文件整段发给 AI：

- Day 1：[day1-minimal-graph.md](day1-minimal-graph.md)
- Day 2：[day2-state-reducers.md](day2-state-reducers.md)
- Day 3：[day3-conditional-edges.md](day3-conditional-edges.md)
- Day 4：[day4-persistence.md](day4-persistence.md)
- Day 5：[day5-interrupt-streaming.md](day5-interrupt-streaming.md)
- Day 6：[day6-subgraph-multi-agent.md](day6-subgraph-multi-agent.md)
- Day 7：[day7-final-project.md](day7-final-project.md)

## 目录约定

- 每天独立目录 `src/day1` ～ `src/day7`，不跨日 import，不共用 `src/shared`
- 每天在根 `package.json` 的 `scripts` 里加一条 `dayN`，不改已有脚本
- env 读取、模型初始化在每天目录内复制一份，保持独立可运行
- 综合项目放 `src/final-project`，不依赖任何 day 目录

---

## Day 1：环境与最小状态图

**目标**

搭出项目骨架，写出第一个 `StateGraph`，理解“节点返回部分更新”。

**知识点**

- `new StateSchema({ ... })` 定义状态，字段带 `zod` 类型和默认值
- 节点函数签名：接收完整 State，返回**部分更新**
- `new StateGraph(StateSchema)`、`addNode`、`addEdge`
- `START` / `END` 哨兵，`compile()` 才校验图合法性
- `invoke` 与 `stream({ streamMode: "updates" })`
- `StateGraph` 与 `createAgent` 的关系：后者内部就是一张图

**产出**

- `package.json`、`tsconfig.json`、`.env.example`
- `src/day1/model.ts`（`loadEnv` / `createChatModel` / `describeError`）
- `src/day1/graph.ts`：`START → classify → answer → review → END`

**验收**

- `npm run typecheck` 通过
- `npm run day1` 打印三个问题的 `category` / `answer` / `steps`
- 节点名不与状态字段同名，`steps` 每次都是完整数组

---

## Day 2：状态设计与 reducer

**目标**

搞清“后写覆盖前写”和“自定义合并”的差别，能设计多节点共享的状态。

**知识点**

- 普通字段默认覆盖；`ReducedValue` 自定义 reducer
- `ReducedValue` 的 `inputSchema` + `reducer`，节点只返回增量
- `MessagesValue`：消息数组通道，自动追加并合并 `AIMessageChunk`
- 并行分支写同一字段时的合并顺序
- `config.configurable` 传业务参数（如 `userId`）
- `updateState`：不跑图，直接改线程状态

**产出**

- `src/day2/state.ts`：一套完整状态定义（`messages` / `steps` / `findings` / `score`）
- `src/day2/reducers.ts`：累积、去重、取最大值的三个 reducer 演示
- `src/day2/parallel.ts`：两个节点各自写入同一字段

**验收**

- `steps` 是累加数组，`score` 取最大值而不是被覆盖
- 用 `MessagesValue` 后，状态里的 `messages` 能跨节点保留
- 能说清什么时候用 reducer、什么时候直接覆盖

---

## Day 3：条件边、循环与工具循环

**目标**

让图能分支和循环，并手写一遍 ReAct 循环，彻底看懂 `createAgent` 内部。

**知识点**

- `addConditionalEdges(源节点, 路由函数, 目标映射)`
- 路由函数只读 State、返回节点名或 `END`
- 循环图：`model → tools → model`，直到没有 `tool_calls`
- `recursionLimit` 与死循环保护
- 工具执行失败、未知工具要回填而不是抛出
- 对照 `createAgent`：它省掉的是循环控制，不是协议本身

**产出**

- `src/day3/tools.ts`：时间、计算器、检索三个工具
- `src/day3/react-graph.ts`：`modelNode` / `toolsNode` / 路由函数
- `src/day3/run.ts`：单工具、多工具、超限三轮演示

**验收**

- 无工具问题时图直接结束
- 多工具问题能看到多轮 `tools → model`
- 故意死循环时抛出可读的 recursion 提示
- 工具异常转成文本回填，进程不崩

---

## Day 4：持久化与时间旅行

**目标**

把图的状态存下来，理解 `thread_id`、checkpoint 和历史回放。

**知识点**

- checkpointer 是“每个线程每个超步的状态快照”
- `MemorySaver` 只存进程内存，重启即丢
- `SqliteSaver`：本地文件持久化，重启后仍可续聊
- `thread_id` 隔离；`getState` / `getStateHistory`
- 时间旅行：从历史 checkpoint 恢复、`updateState` 分叉出新分支
- checkpointer 与 `createAgent` 的 `checkpointer` 是同一套机制

**产出**

- `src/day4/memory.ts`：`MemorySaver` 四轮隔离演示
- `src/day4/sqlite.ts`：`SqliteSaver` 重启续聊演示
- `src/day4/time-travel.ts`：打印历史步骤、从第 2 步重跑

**验收**

- 同一 `thread_id` 记得前文，不同 `thread_id` 完全隔离
- 结束进程再启动，SQLite 线程仍能回答前文
- `getStateHistory` 能列出每次 checkpoint 的节点和状态摘要
- 能从旧 checkpoint 分支重跑，旧分支状态不被污染

---

## Day 5：中断、人工审批与流式

**目标**

让图能暂停等人审批，并把执行过程流式推给调用方。

**知识点**

- `interrupt(payload)` 在节点内暂停，返回中断信息
- 恢复必须用 `Command({ resume })` 且同一个 `thread_id`
- 中断依赖 checkpointer，MemorySaver 也可，但重启即丢
- 多处中断的 resume 顺序与 `resume` 数组
- `streamMode`：`values` / `updates` / `messages` / `custom`
- `getWriter()` 写自定义事件，前端据此显示进度
- `config.signal` 取消、`recursionLimit` 兜底

**产出**

- `src/day5/approval.ts`：`draft → review(interrupt) → publish / revise`
- `src/day5/stream.ts`：`custom` + `messages` 两种流式输出
- 通过、拒绝、修改后再审三条路径

**验收**

- 审批通过走 `publish`，拒绝走 `revise`，拒绝原因进入状态
- 中断后发新 `HumanMessage` 能看出问题（用于对比正确用法）
- 流式输出能看到节点进度和逐字文本
- 取消时进程干净退出，不留悬挂请求

---

## Day 6：子图、并行与多 Agent

**目标**

把大图拆成子图，用 `Send` 并行分发，理解 supervisor 模式。

**知识点**

- 编译后的图可以作为父图的一个节点
- 父子图共享字段 vs 独立 schema 的取舍
- `Send` API：按列表动态分发并行节点，配 reducer 汇总
- 并行分支的合并时机与幂等要求
- supervisor 模式：一个路由 Agent 决定交给哪个 worker
- 函数式 API `entrypoint` / `task` 的适用场景（了解即可）

**产出**

- `src/day6/subgraph.ts`：`research` 子图嵌进主图
- `src/day6/send.ts`：三个 query 并行检索后汇总
- `src/day6/supervisor.ts`：`research_agent` / `writer_agent` 两个 worker + 路由

**验收**

- 主图能调用子图，子图状态不污染父图无关字段
- `Send` 三个分支并行执行，最终汇总成一个数组
- supervisor 能按问题类型切换 worker，并回到 supervisor 收尾
- 能说清什么时候该拆子图，什么时候一张图就够

---

## Day 7：综合项目（带审批的研究助手）

**目标**

把六天的能力串成一个独立可演示的 CLI 项目，不再依赖任何 day 目录。

**图结构**

```text
START → plan → (Send 并行 research 子图) → draft
      → review(条件边) ──需修改──→ draft
                        └─通过──→ approval(interrupt) → finalize → END
```

**功能**

- `plan`：用结构化输出拆出 2～3 个检索子任务
- `research` 子图：并行检索 + 去重 + 带来源
- `draft`：汇总成带引用 `[来源: 文件#chunk]` 的草稿
- `review`：自检是否覆盖全部子任务，不达标回流 `draft`
- `approval`：`interrupt` 人工确认，拒绝则回 `draft` 并带上意见
- `SqliteSaver` 持久化，支持重启续跑
- `custom` 流式打印每个节点的进度

**验收**

- 独立安装、`typecheck` 通过
- 一次完整流程能看到并行检索、回流、审批中断与恢复
- 中断后重启进程，仍能接着审批
- 知识库外的问题不编造，草稿带来源
- 代码中没有 import 任何 day 目录

---

## 与 LangChain 项目的差异

| 能力 | LangChain 两周里 | 这一周 |
|---|---|---|
| Agent | `createAgent` 黑盒循环 | 自己画图，看清每步 |
| 记忆 | checkpointer + `thread_id` | 多线程、持久化、时间旅行 |
| 审批 | middleware HITL | 图内 `interrupt` + `Command` |
| 流程 | 基本线性 | 分支、循环、并行、子图 |
| 调试 | LangSmith | 加上 `getStateHistory` 回放 |

## 检查点

每完成一天，问自己三个问题：

1. 今天新增的 API，能不能用一句话说清它解决什么问题？
2. 出问题时，是状态定义、边、checkpointer 还是中断恢复的锅？
3. 如果去掉这个能力，`createAgent` 能不能替代？

一周结束后应能独立完成：

- 给一张图加一个分支节点和条件边
- 把一张线性图改成带审批的可恢复流程
- 用 `Send` 把串行步骤改成并行
- 用 `getStateHistory` 定位一次状态合并错误
- 判断一个需求该用 `createAgent` 还是自己写图

## 暂不深入

- LangGraph Platform 部署、`@langchain/langgraph-sdk` 托管
- 生产级分布式 checkpointer（Postgres / Redis）
- 复杂多 Agent 拓扑（层级团队、swarm 动态交接）
- 自定义持久化存储、跨服务状态同步
