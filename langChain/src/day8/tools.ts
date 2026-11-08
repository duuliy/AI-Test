/**
 * Day 8 · 四个工具，每个对应一种 middleware 能力
 *
 * A. flaky_search   —— 前 2 次抛错、第 3 次成功，验证 toolRetryMiddleware
 * B. delete_note    —— 危险操作，验证 humanInTheLoopMiddleware
 * C. broken_weather —— 永远抛错，验证自定义 wrapToolCall 错误处理
 * D. get_current_time —— 安全工具对照，不会触发任何 middleware 的拦截逻辑
 *
 * 为什么每个场景都要专用工具？
 * middleware 是按「工具名」匹配的（retry 的 tools 白名单、HITL 的 interruptOn），
 * 用独立工具可以把各场景彻底隔开：A 失败不会污染 C 的异常，
 * B 的中断也不会影响 A 的重试次数。共用工具时很容易互相串味，调试时会很痛苦。
 */
import { tool, type StructuredToolInterface } from "@langchain/core/tools"; // tool 用来声明工具；StructuredToolInterface 是工具数组的元素类型
import { z } from "zod"; // zod 用来定义工具的入参 schema（模型据此生成参数）

/* -------------------------------------------------------------------------- */
/* A. flaky_search：用模块级计数器模拟不稳定的网络                             */
/* -------------------------------------------------------------------------- */
/*
 * 设计要点：
 * 1. 计数器放在模块作用域，而不是工具参数里 —— 同一进程内前两次调用必然失败，
 *    第三次必然成功，重试结果稳定可复现，不依赖随机数。
 * 2. 每次尝试都打日志，这样能从输出里直接数出「一共被调用了 3 次」，
 *    而不是只看最后结果就断言重试生效。
 * 3. 抛的是普通 Error（不是字符串），toolRetryMiddleware 默认对 Error 重试。
 */
let flakyCallCount = 0; // 模块级计数器：记录 flaky_search 已被调用过几次（进程内共享）

const flakySearch = tool(
  // 用 tool() 声明一个可被模型调用的工具
  async ({ query }) => {
    // 第一个参数是工具实现函数；{ query } 由 schema 校验后再传进来
    flakyCallCount += 1; // 每调用一次就自增，作为「这是第几次尝试」
    const attempt = flakyCallCount; // 存成本地变量，避免日志与判断之间计数被别处改掉

    // 第 1、2 次模拟临时网络故障；第 3 次才真正返回结果
    if (attempt <= 2) {
      // 前两次尝试
      console.log(`  [flaky_search] 第 ${attempt} 次尝试 → 抛错：临时网络错误`); // 打日志：让重试过程可见
      throw new Error("临时网络错误"); // 抛普通 Error，交给 toolRetryMiddleware 捕获并重试
    }

    console.log(`  [flaky_search] 第 ${attempt} 次尝试 → 成功`); // 第三次及以后：打印成功
    return `搜索结果：关于「${query}」的模拟数据（第 ${attempt} 次调用才拿到）`; // 返回值会被包成 ToolMessage 交回模型
  },
  {
    // 第二个参数是工具的元信息
    name: "flaky_search", // 工具名：middleware 白名单和 HITL 配置都用这个名字匹配
    // description 会直接喂给模型，写清楚「不稳定、第三次才成功」，
    // 模型才愿意在失败后继续等工具结果，而不是自作主张换方案。
    description:
      "在模拟的搜索服务里检索关键词。该服务不稳定：前两次调用会失败，第三次才会返回结果。用户要求搜索 flaky 数据时调用。",
    schema: z.object({
      // schema 定义入参结构，模型按它生成参数，运行时也按它校验
      query: z.string().min(1).describe("要搜索的关键词，例如 flaky 数据"), // 必填字符串，describe 的内容会出现在工具签名里
    }),
  },
);

/* -------------------------------------------------------------------------- */
/* B. delete_note：只返回文本，不真正删除任何文件                              */
/* -------------------------------------------------------------------------- */
/*
 * 演示 HITL 时，「工具本身做什么」并不重要，重要的是它被标记为危险操作。
 * 这里刻意不写任何文件系统逻辑：即使人工点了 approve，
 * 也只是回填一句「已删除笔记 xxx」，不会真的删掉你的笔记文件。
 * 这样反复运行 Demo 也不会造成副作用。
 */
const deleteNote = tool(
  // 声明 delete_note 工具
  ({ noteId }) => {
    // 同步实现即可：这里没有任何 IO
    // 演示模式：绝不触碰真实文件系统，只回填一句“已删除”
    console.log(`  [delete_note] 收到删除请求：${noteId}`); // 打印日志：approve 之后才会看到这一行
    return `已删除笔记 ${noteId}`; // 返回文本结果；注意这只是模拟，磁盘上什么都没发生
  },
  {
    // 元信息
    name: "delete_note", // 工具名：HITL 的 interruptOn key 必须与它完全一致
    // description 里明确写「执行前需要人工批准」，
    // 与 middleware 的 interruptOn 配置形成双重提示：模型知道这是危险操作。
    description: "删除指定 ID 的笔记。这是危险操作，执行前需要人工批准。",
    schema: z.object({
      // 入参 schema
      noteId: z.string().min(1).describe("要删除的笔记 ID，例如 note-1"), // 必填的笔记 ID
    }),
  },
);

/* -------------------------------------------------------------------------- */
/* C. broken_weather：永远抛异常，交给自定义 middleware 兜底                    */
/* -------------------------------------------------------------------------- */
/*
 * 这个工具用来验证「异常 → ToolMessage」的转换：
 * - 不挂自定义 middleware 时，ToolNode 也有默认兜底，但文案是英文且不可控；
 * - 挂了自定义 wrapToolCall 后，异常会先经过我们的 middleware，
 *   由我们决定给模型看什么文案（这里是中文 + 明确的「请告知用户」指令）。
 * 注意：这里抛的是同步 throw，async 工具里 reject 的 Promise 效果等价。
 */
const brokenWeather = tool(
  // 声明 broken_weather 工具
  ({ city }) => {
    // 工具实现：无论输入什么都会失败
    console.log(`  [broken_weather] 收到查询：${city} → 抛错：天气服务不可用`); // 先打日志，再抛错
    throw new Error("天气服务不可用"); // 异常会穿过 ToolNode 进入 middleware 的 catch
  },
  {
    // 元信息
    name: "broken_weather", // 工具名：C 场景打印时会按这个名字筛选 ToolMessage
    description: "查询指定城市的天气。当前服务故障，调用一定会抛异常。用户问天气时调用。", // 告诉模型「调用一定失败」，它仍会尝试
    schema: z.object({
      // 入参 schema
      city: z.string().min(1).describe("城市名，例如 北京"), // 必填的城市名
    }),
  },
);

/* -------------------------------------------------------------------------- */
/* D. get_current_time：安全工具对照                                           */
/* -------------------------------------------------------------------------- */
/*
 * 这是对照组：既不失败、也不危险，所以 retry / HITL / 错误兜底都不会碰它。
 * 放在 D 场景里还能顺带让对话变长（每次调用多出 AI + Tool 两条消息），
 * 帮助更快触发摘要阈值。
 */
const DEFAULT_TIMEZONE = "Asia/Shanghai"; // 默认时区：模型不传 timezone 时使用

const getCurrentTime = tool(
  // 声明时间工具
  ({ timezone }) => {
    // timezone 是可选参数
    // 参数可选：模型没给 timezone 时退回默认时区，避免 schema 校验直接失败
    const tz = timezone?.trim() || DEFAULT_TIMEZONE; // 去空格；空字符串也视为未传

    try {
      // 用 Intl 而不是手动算时差：DST（夏令时）等情况交给运行时处理
      const formatter = new Intl.DateTimeFormat("zh-CN", {
        // 创建中文格式的日期格式化器
        timeZone: tz, // 指定 IANA 时区
        year: "numeric", // 年
        month: "2-digit", // 月（两位）
        day: "2-digit", // 日（两位）
        hour: "2-digit", // 时（两位）
        minute: "2-digit", // 分（两位）
        second: "2-digit", // 秒（两位）
        hour12: false, // 24 小时制，避免出现「下午 3 点」
      });
      return `时区 ${tz} 的当前时间：${formatter.format(new Date())}`; // 格式化当前时间并返回
    } catch {
      // 时区名非法属于「参数错误」，返回文本而不是抛异常：
      // 模型看到可读提示后可以自己纠正参数再调用一次。
      return `错误：无法识别的时区 "${tz}"，请使用 IANA 时区名，例如 Asia/Shanghai。`; // 用文本回填错误，让模型自行纠错
    }
  },
  {
    // 元信息
    name: "get_current_time", // 工具名
    description: "获取指定 IANA 时区的当前时间，省略 timezone 时默认 Asia/Shanghai。", // 说明可选参数行为
    schema: z.object({
      // 入参 schema
      timezone: z
        .string() // 字符串
        .optional() // 可选：不传也能通过校验
        .describe("IANA 时区名，例如 Asia/Shanghai；省略时默认 Asia/Shanghai"), // 给模型的参数说明
    }),
  },
);

/* -------------------------------------------------------------------------- */
/* 导出                                                                         */
/* -------------------------------------------------------------------------- */
// 用 StructuredToolInterface[] 而不是 any[]：createAgent 需要工具带 schema，
// 这样后续给 middleware 传 tools 白名单时类型也能对上。
export const tools: StructuredToolInterface[] = [
  // 导出工具数组，middleware.ts 里直接传给 createAgent
  flakySearch, // A：可重试的搜索工具
  deleteNote, // B：需要人工审批的删除工具
  brokenWeather, // C：永远抛错的天气工具
  getCurrentTime, // D：安全的时间工具
];
