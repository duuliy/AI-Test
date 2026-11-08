import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // 根目录还有别的 package-lock.json；显式指定工作区根，避免 Next 误判 workspace root
  outputFileTracingRoot: process.cwd(),
    // langchain 的 initChatModel 内部用变量包名做动态 import（如 @langchain/openai），
  // webpack 无法静态分析，运行时会报 Cannot find module。
  // 声明为 server external packages 后，服务端走 Node 原生模块解析，动态 import 才能生效。
  serverExternalPackages: ["langchain", "@langchain/openai", "@langchain/core", "@langchain/langgraph"]
};

export default nextConfig;
