# Agent、Middleware 与 Checkpointer

## createAgent

`createAgent` 是 LangChain v1 的高层入口，把模型、工具、系统提示词、中间件和 checkpointer 组装成一个可执行 Agent。它的内部是一个循环：模型判断是否需要工具，需要就返回 tool_calls；框架执行工具并回填 ToolMessage；模型再根据结果决定继续调用还是给出最终回答。

## systemPrompt

系统提示词是每轮注入的行为约束，不进入用户可见的消息历史。它应该写清楚回答语言、何时必须调用工具、资料不足时如何处理。比如时间问题必须调用时间工具，知识库问题只能依据检索结果，不能凭常识补全。提示词约束语义，schema 约束参数形状，两者不能互相替代。

## Middleware

中间件在 Agent 执行流程的关键位置插入逻辑。本项目用到三种：

- `toolRetryMiddleware` 在工具抛错时自动重试，适合网络抖动等临时故障。
- 自定义 `wrapToolCall` 用 try/catch 包住工具执行，把异常转换成带正确 `tool_call_id` 的 ToolMessage，让模型能如实告诉用户“工具暂时不可用”，而不是让整个 Agent 崩溃。
- `summarizationMiddleware` 在消息数达到阈值时把旧历史压缩成摘要，只保留最近几条，控制上下文长度。

包裹顺序会影响行为：错误处理放在外层、重试放在内层，重试才能看到真实异常；如果错误处理先吞掉异常，重试会把“错误回填”当成成功，只执行一次。

## Checkpointer

`MemorySaver` 是内存版 checkpointer。它在每次执行后保存该线程的完整状态，主要是消息数组。调用时传入相同的 `thread_id`，框架就会读出历史并追加新消息，实现多轮记忆；换一个 `thread_id` 则完全隔离。

需要注意：记忆保存在服务端 checkpointer 里，模型本身仍然无状态。MemorySaver 只活在当前进程，重启或热更新就会丢失，生产环境应换成 SQLite、Postgres 或 Redis 等持久化实现。

## 顺序与边界

工具、中间件和提示词都不是“越多越好”。工具越多，模型选错的概率越高；中间件越多，排查链路越长；提示词越长，越容易互相冲突。先保证最小可用链路，再按实际问题逐步增加，是更稳妥的做法。
