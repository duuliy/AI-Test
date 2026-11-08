# LangChain v1 基础概念

LangChain 是一个用于构建大模型应用的框架，它把"调用模型"这件事拆成几个稳定的抽象：模型、消息、工具和 Agent。v1 版本的思路是把这些能力尽量收拢到 `langchain` 与 `@langchain/core` 两个包里，旧的 `AgentExecutor`、`initializeAgentExecutorWithOptions` 等写法已经不再推荐使用，新的入口是 `initChatModel` 与 `createAgent`。

模型（Model）负责真正发起推理请求。聊天模型接收一组消息，返回一条 AI 消息。项目里通常用 OpenAI 兼容协议接入不同厂商，靠 `OPENAI_BASE_URL` 区分服务地址，靠 `OPENAI_MODEL` 指定模型名，因此同一套代码可以在 OpenAI、智谱、DeepSeek 等平台之间切换。

消息（Message）是模型输入输出的统一载体，分为系统消息（SystemMessage）、用户消息（HumanMessage）、AI 消息（AIMessage）和工具消息（ToolMessage）。系统消息用来放人设和规则，用户消息放当前问题，AI 消息可能带着工具调用请求，工具消息则携带工具执行结果。多轮对话的本质，就是不断把历史消息追加到一个数组里再发给模型。

工具（Tool）是给模型调用的函数。用 `tool()` 配合 `zod` 描述函数名、说明和参数结构，模型就能根据自然语言决定何时调用、传什么参数。工具本身不关心模型，它只负责执行并把结果转成字符串或结构化内容返回。

Agent 是把模型、工具和循环逻辑组合起来的运行时。模型决定下一步做什么，Agent 负责执行工具、把结果回填成消息、再次请求模型，直到模型不再调用工具为止。理解这个循环，就能理解为什么 Agent 可以完成多步任务，也能理解为什么参数校验、错误处理和超时控制同样重要。

此外还有几个常用概念：`prompt template` 负责拼接提示词；`output parser` 负责把模型输出解析成结构化数据；`retriever` 负责从知识库中取回相关片段。它们既可以单独使用，也可以被 Agent 间接调用。掌握这些抽象的分工，比记住具体 API 名称更重要。
