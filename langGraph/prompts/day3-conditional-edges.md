# Day 3 提示词：条件边、循环与工具协议

> 用法：在项目根目录开启新会话，把本文件内容整段发给 AI。这是一个独立任务，不依赖其他 prompt 文件。

## 背景

你是一名资深 TypeScript 工程师，带我学习 LangGraph.js v1。项目根目录就是当前工作目录，Day 1～2 已完成：最小状态图、reducer、并行分支、`updateState`。

今天不用 `createAgent`，而是自己画一张 ReAct 循环图，把“模型返回 `tool_calls`、本地执行、回填 `ToolMessage`、再次调用模型”的过程完整写出来。

## 硬性约束：独立日代码

- 只新建 `src/day3/` 下的文件
- 允许在根 `package.json` 的 `scripts` 中新增 `day3`，允许新增依赖；不得升级、降级或删除已有依赖，不得改动其他脚本
- 不 import `src/shared`、`src/day1`、`src/day2`；env 读取和模型初始化复制到 `src/day3/` 内
- 不修改其他 day 的任何文件，不改根 `tsconfig.json` 和 `PLAN.md`

## 目标

- 掌握 `addConditionalEdges`：路由函数只读 State，返回节点名或 `END`
- 写出 `model → tools → model` 的循环，并理解终止条件
- 理解 `bindTools` 只发工具定义、不执行工具
- 理解 `ToolMessage` 的 `tool_call_id` 为什么必须对应
- 用 `recursionLimit` 和异常兜底防止死循环、进程崩溃

## 开始前

先读：

1. `PLAN.md`
2. `src/day1/graph.ts` 和 `src/day2/reducers.ts` 中状态与图的写法
3. `node_modules/@langchain/langgraph/dist/graph/graph.d.ts` 中 `addConditionalEdges` 的两个重载
4. `node_modules/@langchain/langgraph/dist/graph/types.d.ts` 中 `ConditionalEdgeRouter`、路由返回值类型
5. `node_modules/@langchain/langgraph/dist/pregel/types.d.ts` 中 `recursionLimit`
6. `node_modules/@langchain/core/dist/tools/index.d.ts` 中 `tool()` 的参数
7. `node_modules/@langchain/core/dist/messages/tool.d.ts` 中 `ToolMessage` 的字段

## 任务

### 1. 配置

新建 `src/day3/model.ts`，内容同 Day 1 的 `model.ts`（独立复制）。

### 2. 工具

新建 `src/day3/tools.ts`，用 `tool()` 加 Zod 定义四个工具：

- `get_current_time`：参数 `{ timezone?: string }`，返回当前时间字符串
- `calculate`：参数 `{ a: number, b: number, op: "+" | "-" | "*" | "/" }`，除零返回错误文案，禁止 `eval` / `new Function`
- `search_docs`：参数 `{ query: string }`，在模块内固定的小文档数组里做关键词匹配，返回前两条，找不到返回“没有找到相关内容”
- `broken_lookup`：参数 `{ query: string }`，永远抛 `Error("检索服务不可用")`，专门用来验证异常兜底

每个工具都要写清 `description`（什么时候调用）和参数 schema。

### 3. ReAct 图

新建 `src/day3/react-graph.ts`：

- 状态：`messages: MessagesValue`、`rounds: z.number().default(0)`
- `modelNode`：
  - 用 `model.bindTools(tools)` 后调用 `invoke(state.messages)`
  - 把返回的 `AIMessage` push 进 `messages`
  - `rounds + 1`
- `toolsNode`：
  - 只处理最后一条 `AIMessage` 的 `tool_calls`
  - 按名字从工具表里查；查不到返回“未知工具：xxx”
  - 每个工具调用用 `try/catch` 包住，异常转成错误字符串，不要抛出
  - 每条结果都构造成 `ToolMessage`，`tool_call_id` 必须用对应 `tool_call.id`
- 路由函数：最后一条消息是 `AIMessage` 且有 `tool_calls` 就返回 `"tools"`，否则返回 `END`
- 图结构：
  - `START → model`
  - `model` 用 `addConditionalEdges` 指向 `tools` / `END`
  - `tools → model`
- `compile()` 导出可复用实例

### 4. 演示脚本

新建 `src/day3/run.ts`，按顺序打印分节标题：

**A. 不调工具**

- 问题：`用一句话解释什么是图编排`
- 期望直接结束，没有 `tool_calls`

**B. 单工具**

- 问题：`现在上海几点？`

**C. 多工具**

- 问题：`现在几点？再算一下 37 * 19`
- 期望看到多轮 `model → tools → model`

**D. 工具异常**

- 问题：`帮我查一下 broken lookup 里的内容`
- 期望 `broken_lookup` 抛出的异常变成 `ToolMessage`，图继续走完，进程不崩

**E. 循环保护**

- 对 C 的问题传入 `{ recursionLimit: 4 }`
- 捕获 `GraphRecursionError`，打印中文提示，说明默认限制和如何调整
- 注意：这是故意触发的演示，不要吞掉后假装成功

每个场景用 `message.content` 提取最终文本，并统计本轮 `tool_calls` 总数（从消息历史里筛选，不要自己维护计数器）。

### 5. 脚本

在 `package.json` 增加：

```json
"day3": "tsx src/day3/run.ts"
```

## 约束

- 不使用 `createAgent` 或任何预构建 Agent
- 不加 middleware、checkpointer、中断
- 不接真实搜索或天气 API
- 不改 Day 1～2 的文件
- TypeScript strict，相对导入写 `.js` 后缀
- 注释用中文

## 验收

```bash
npm run typecheck
npm run day3
```

通过标准：

- A 场景无工具调用，直接输出回答
- B、C 能正确选中工具，C 出现多轮工具调用
- D 场景的错误以文本形式回到模型，图正常结束
- E 场景能捕获到递归限制错误并输出可读提示
- 每条 `ToolMessage` 的 `tool_call_id` 都能和 `tool_calls` 对上
- 代码中没有 `eval` / `new Function`

## 讲解要求

重点讲：

- `bindTools` 到底做了什么、没做什么
- 路由函数为什么只读 State，不能有副作用
- 没有 `tool_calls` 时循环靠什么结束
- `recursionLimit` 保护的是哪一层

## 汇报

完成后告诉我：

1. 新增了哪些文件
2. 这张图有几个节点、几条边，路由函数返回什么
3. C 场景实际的调用轮数和工具名
4. D 场景最终 `ToolMessage` 的内容
5. E 场景捕获到的错误类型和提示文案
6. 和 `createAgent` 相比，这张图少了哪些能力
