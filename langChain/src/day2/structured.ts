/**
 * Day 2 · 结构化输出（逐行注释版）
 *
 * 建议阅读顺序：
 * 1. IntentSchema / MeetingSchema：先看输出的「形状」；
 * 2. z.infer：再看 TypeScript 类型如何从 schema 自动推导；
 * 3. normalizeMeeting：模型输出不可信，业务层如何兜底；
 * 4. Runner / callStructured：如何封装调用与重试；
 * 5. main：两个 demo 如何串起来，以及每组用例想验证什么。
 *
 * 一条主线：schema 管形状，system prompt 管语义，后处理管兜底。
 */
import { HumanMessage, SystemMessage, type BaseMessage } from "@langchain/core/messages"; // Human=用户输入，System=系统规则，BaseMessage=消息基类
import { z } from "zod"; // z 用来定义 schema，并在运行时校验模型输出
import { createModel, describeError, loadEnv } from "../shared/model.js"; // 复用项目里模型初始化、错误格式化、.env 加载

/**
 * 意图路由 schema（输出的「形状」）。
 * 这里不是普通对象校验：withStructuredOutput 会把它转成 JSON Schema，
 * 再作为 tool 的 parameters 发给模型。因此 .describe() 的文案会直接影响模型理解，
 * 要写成“模型能执行的指令”，而不是写给人看的注释。
 * enum 则把可选值收窄成四个，模型无法编造第五种意图。
 */
export const IntentSchema = z.object({ // z.object 表示输出必须是一个对象
  intent: z // 定义 intent 字段
    .enum(["weather", "calculator", "knowledge_search", "chitchat"]) // 只能取这四个字符串之一
    .describe("用户这句话最可能对应的处理意图"), // describe 会写进 JSON Schema，模型能读到
  confidence: z // 定义 confidence 字段
    .number() // 类型必须是 number
    .min(0) // 下限 0
    .max(1) // 上限 1
    .describe("对上述意图判断的把握程度，0 表示完全不确定，1 表示非常确定"), // 告诉模型这个数的含义
  reason: z.string().describe("用一句简短的中文说明为什么选择这个意图"), // 字符串类型的判断理由
}); // IntentSchema 结束

/**
 * 会议信息抽取 schema。
 * 目标是把一句自然语言压成固定结构，供日历、任务系统直接消费；
 * 字段宁愿显式是 null，也不要缺省，这样下游可以稳定地做判空。
 */
export const MeetingSchema = z.object({ // 会议信息也必须是一个对象
  // 这里统一用 .nullable() 而不是 .optional()：
  // nullable 表示字段一定存在、值可以是 null，适合让模型明确表达“没提到”；
  // optional 表示字段可以整个缺失，序列化后容易变成 undefined 甚至被省略，不利于校验。
  title: z.string().nullable().describe("会议主题；原文未提及时返回 null"), // 字符串或 null
  startTime: z.string().nullable().describe("会议开始时间；原文未提及时返回 null"), // 字符串或 null
  location: z.string().nullable().describe("会议地点；原文未提及时返回 null"), // 字符串或 null
  attendees: z.array(z.string()).describe("参会人姓名列表；原文未提及时返回空数组"), // 字符串数组，缺失时是 []
  durationMinutes: z // 定义会议时长字段
    .number() // 必须是数字
    .int() // 必须是整数
    .positive() // 必须是正数
    .nullable() // 允许为 null
    .describe("会议时长，单位分钟，必须是正整数；原文未提及时返回 null"), // 告诉模型取值范围与缺失写法
}); // MeetingSchema 结束

// 输出类型直接从 schema 推导，schema 改动时类型会自动同步，避免手写 interface 与 schema 漂移。
// AppModel 同理：createModel 的返回类型由 initChatModel 推导，不重复写死具体类名。
type IntentOutput = z.infer<typeof IntentSchema>; // 从 IntentSchema 推导 TS 类型
type MeetingOutput = z.infer<typeof MeetingSchema>; // 从 MeetingSchema 推导 TS 类型
type AppModel = Awaited<ReturnType<typeof createModel>>; // 取 createModel 返回值的类型（Awaited 解开 Promise）

/**
 * glm-5.3-flash 在 functionCalling 下会把 nullable 字段填成字符串 "null"，
 * 这是模型输出习惯，不是 schema 的问题。业务层做一次兜底归一化，
 * 保证缺失字段最终是真正的 null，而不是字符串 "null" 或空串。
 */
function normalizeMeeting(meeting: MeetingOutput): MeetingOutput { // 入参和返回值都是会议结构
  const toNull = (value: string | null): string | null => { // 内部小工具：把“假空值”转成 null
    if (value === null) return null; // 本来就是 null，直接返回
    const trimmed = value.trim(); // 去掉首尾空白，便于判断空串
    // 只把“明确表示缺失”的写法归一化，避免把真实的地名、主题误伤成 null
    return trimmed === "" || trimmed.toLowerCase() === "null" ? null : value; // 空串或 "null" → null，否则保留原值
  }; // toNull 结束

  return { // 返回一个新的会议对象，不修改入参
    ...meeting, // 先展开复制所有字段
    title: toNull(meeting.title), // 归一化主题
    startTime: toNull(meeting.startTime), // 归一化开始时间
    location: toNull(meeting.location), // 归一化地点
  }; // 新对象结束
} // normalizeMeeting 结束

// withStructuredOutput 返回的是 Runnable，这里只声明实际用到的 invoke。
// 既保留类型安全，又不依赖 Runnable 的完整泛型签名，后续换 provider 也不受影响。
interface Runner<T> { // 泛型接口，T 是结构化结果类型
  invoke(messages: BaseMessage[]): Promise<T>; // 只要求一个 invoke 方法
} // Runner 结束

// schema 只约束“形状”，system prompt 负责约束“语义”：
// 什么算模糊输入、置信度该高还是该低，这些规则写不进 JSON Schema。
const INTENT_SYSTEM_PROMPT = [ // 用数组拼多行提示词，便于逐条阅读
  "你是一个意图路由分类器。", // 第一条：角色设定
  "根据用户的话选择最合适的 intent，并给出 0~1 的 confidence 和一句简短理由。", // 第二条：任务说明
  "信息不足、指代不清或像随口闲聊时，confidence 要明显偏低，不要强行猜测。", // 第三条：模糊输入的处理规则
].join("\n"); // 用换行符把三条拼成一段

// 显式强调“不要输出字符串 null”，是因为 GLM 曾把缺失字段填成 "null"。
// 提示词只能降低概率，不能保证，所以解析后还有 normalizeMeeting 兜底。
const MEETING_SYSTEM_PROMPT = [ // 会议抽取的系统提示词
  "你是一个会议信息抽取器。", // 第一条：角色设定
  "只抽取用户原文中明确出现的信息，不要根据常识补全。", // 第二条：只抽原文，不脑补
  '未提及的字符串字段必须返回 JSON null，不要输出字符串 "null"，也不要留空字符串；未提及参会人时返回空数组，未提及时长时返回 null。', // 第三条：缺失值写法
].join("\n"); // 拼接成一段

/**
 * 结构化输出失败通常来自这几类原因：
 * 1. provider 不支持当前 method（例如智谱兼容端点不认 response_format.json_schema，直接 400）；
 * 2. 模型没有按工具参数返回，或返回了被截断 / 多余的文本，解析失败；
 * 3. schema 里出现 provider 不支持的 JSON Schema 关键字（如 union type、复杂嵌套）。
 * 因此这里只做一次重试，避免把同一个确定性错误反复打给接口。
 */
async function callStructured<T>( // 泛型函数，T 由传入的 runner 决定
  label: string, // 日志里显示的标签，例如“意图路由”
  runner: Runner<T>, // 负责一次结构化调用的执行器
  messages: BaseMessage[], // 本轮发给模型的消息
): Promise<T | null> { // 成功返回 T，失败返回 null
  for (let attempt = 1; attempt <= 2; attempt += 1) { // 最多尝试 2 次
    try { // 捕获网络、解析、校验等所有异常
      const result = await runner.invoke(messages); // 一次完整调用：请求 + JSON 解析 + Zod 校验
      // 解析器在 provider 返回空 tool 参数时可能给出 null；
      // 这类结果不满足业务对“对象”的预期，按失败处理，避免后续解构时崩溃。
      if (result === null) { // 结果是 null 说明没有拿到对象
        console.error(`[${label}] 模型返回了 null，而不是符合 schema 的对象。`); // 打印失败原因
        return null; // 直接放弃这条输入
      } // 空结果判断结束
      return result; // 拿到合法对象，直接返回
    } catch (error) { // 任何异常都在这里处理
      console.error(`[${label}] 第 ${attempt} 次调用失败：${describeError(error)}`); // 打印第几次、为什么失败
      // 第 1 次失败后立即重试；第 2 次仍失败说明多半是 method 或 schema 不兼容，
      // 继续重试只会重复同一个确定性错误，所以直接放弃这一条输入。
      if (attempt === 2) { // 已经是第二次尝试
        console.error(`[${label}] 已重试 1 次仍然失败，跳过该输入。`); // 说明不再重试
        return null; // 放弃这条输入
      } // 第二次失败判断结束
      console.error(`[${label}] 正在重试 1 次……`); // 第一次失败，准备重试
    } // catch 结束
  } // for 循环结束
  return null; // 理论上走不到，作为兜底返回值
} // callStructured 结束

// 打印 typeof 不只是展示：验收要求缺失字段是 null 而不是 undefined，
// 同时也能快速发现 provider 把数字、数组返回成了字符串。
function printIntent(input: string, result: IntentOutput): void { // 打印意图路由结果
  console.log(`输入：${input}`); // 回显原始输入
  console.log("解析结果：", result); // 直接打印解析后的对象
  console.log( // 打印每个字段的运行时类型
    `typeof intent=${typeof result.intent}，confidence=${typeof result.confidence}，reason=${typeof result.reason}`, // 三个字段的 typeof
  ); // 类型打印结束
  console.log( // 打印 confidence 是否在合法区间
    `confidence 在 0~1 之间：${Number.isFinite(result.confidence) && result.confidence >= 0 && result.confidence <= 1}`, // 先用 isFinite 排除 NaN/Infinity
  ); // 区间检查结束
} // printIntent 结束

function printMeeting(input: string, result: MeetingOutput): void { // 打印会议抽取结果
  console.log(`输入：${input}`); // 回显原始输入
  // 直接打印对象：null 会显示成 null，被省略的 undefined 字段则不会出现，便于肉眼区分
  console.log("解析结果：", result); // 打印完整对象
  console.log( // 打印三个可空字符串字段的实际状态
    `title=${result.title === null ? "null" : typeof result.title}，` + // title：null 或类型名
      `startTime=${result.startTime === null ? "null" : typeof result.startTime}，` + // startTime：null 或类型名
      `location=${result.location === null ? "null" : typeof result.location}`, // location：null 或类型名
  ); // 可空字段打印结束
  console.log( // 打印数组字段
    `attendees 是数组：${Array.isArray(result.attendees)}，长度：${result.attendees.length}`, // 是否数组 + 元素个数
  ); // attendees 打印结束
  console.log( // 打印时长字段
    `durationMinutes=${result.durationMinutes === null ? "null" : typeof result.durationMinutes}` + // 先看 null 还是数字
      (result.durationMinutes === null // 如果是 null
        ? "" // 就不追加正整数判断
        : `，正整数：${Number.isInteger(result.durationMinutes) && result.durationMinutes > 0}`), // 否则检查整数且为正
  ); // durationMinutes 打印结束
} // printMeeting 结束

async function main(): Promise<void> { // 脚本入口
  loadEnv(); // 先加载 .env，模型初始化依赖里面的配置

  let model: AppModel; // 声明模型变量，稍后在 try 里赋值
  try { // 初始化可能因为缺少 key 或配置错误而失败
    // 共享的 createModel 默认 temperature=0：结构化抽取要稳定复现，不需要创造性
    model = await createModel(); // 创建聊天模型实例
  } catch (error) { // 初始化失败
    console.error(describeError(error)); // 打印可读错误
    process.exit(1); // 以失败码退出
  } // try/catch 结束

  // LangChain 对非 gpt-3/gpt-4 的 OpenAI 兼容模型会默认选择 jsonSchema 模式，
  // 但智谱的 OpenAI 兼容端点没有实现 response_format.json_schema，直接调用会 400。
  // 所以显式改成 functionCalling：底层是 tools + tool_choice，兼容性更好。
  // name 会成为发给模型的 tool 函数名，用英文蛇形命名，避免中文或空格被部分 provider 拒绝。
  // withStructuredOutput 返回 Runnable：invoke 时自动完成请求、JSON 解析和 Zod 校验，
  // 业务代码不需要再手动 JSON.parse。
  const intentRunner = model.withStructuredOutput(IntentSchema, { // 把意图 schema 包成结构化执行器
    name: "route_intent", // 发给模型的工具名
    method: "functionCalling", // 用工具调用模式，兼容智谱端点
  }); // intentRunner 结束
  const meetingRunner = model.withStructuredOutput(MeetingSchema, { // 把会议 schema 包成结构化执行器
    name: "extract_meeting", // 发给模型的工具名
    method: "functionCalling", // 同样用工具调用模式
  }); // meetingRunner 结束

  console.log("LangChain.js Day 2 · 结构化输出"); // 打印标题
  console.log(`模型：${process.env.OPENAI_MODEL?.trim() ?? "(未设置)"}`); // 打印当前模型名
  console.log("模式：functionCalling\n"); // 打印调用模式并空一行

  // 意图用例故意分成“明确”和“模糊”两组，用来观察 confidence 是否随信息量变化。
  const intentCases = [ // 意图路由的两条输入
    "上海明天天气怎么样？", // 明确输入，预期 confidence 较高
    "嗯……那个，随便看看吧。", // 模糊输入，预期 confidence 较低
  ] as const; // as const 保留字面量类型

  // 会议用例分成“信息完整”和“几乎没信息”两组，重点验证 null 与空数组的填充。
  // 第二组如果返回 undefined 或字符串 "null"，说明 schema 或 provider 行为不符合预期。
  const meetingCases = [ // 会议抽取的两条输入
    "明天下午 3 点在三楼会议室开产品评审会，参会人有张三、李四、王五，预计 90 分钟。", // 信息完整，预期各字段都有值
    "下周找时间聊聊。", // 几乎没信息，预期字符串字段为 null、数组为空
  ] as const; // as const 保留字面量类型

  for (const input of intentCases) { // 遍历意图用例
    console.log("── 意图路由 ──"); // 打印分组标题
    const messages = [new SystemMessage(INTENT_SYSTEM_PROMPT), new HumanMessage(input)]; // System 放规则，Human 放用户原话
    const result = await callStructured("意图路由", intentRunner, messages); // 调用并拿到结构化结果或 null
    if (result) { // 只有拿到结果才打印
      printIntent(input, result); // 打印解析结果与类型检查
    } // if 结束
    console.log(""); // 每组之间空一行
  } // 意图用例循环结束

  for (const input of meetingCases) { // 遍历会议用例
    console.log("── 会议抽取 ──"); // 打印分组标题
    const messages = [new SystemMessage(MEETING_SYSTEM_PROMPT), new HumanMessage(input)]; // 同样组装 System + Human
    const result = await callStructured("会议抽取", meetingRunner, messages); // 调用并拿到结构化结果或 null
    if (result) { // 只有拿到结果才继续
      printMeeting(input, normalizeMeeting(result)); // 先做缺失值归一化，再打印
    } // if 结束
    console.log(""); // 每组之间空一行
  } // 会议用例循环结束
} // main 结束

await main(); // 顶层 await 启动脚本
