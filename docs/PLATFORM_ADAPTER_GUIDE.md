# 平台适配器开发指南

新增平台时，把平台差异限制在 `src/<platform>/`，再通过 `src/platform/` 的统一消息类型接入 `src/dsh/`。

## 最小职责

```ts
interface PlatformAdapter {
  start(signal: AbortSignal): Promise<void>
  send(message: OutboundMessage, signal: AbortSignal): Promise<void>
  setTyping?(conversationId: string, typing: boolean, signal: AbortSignal): Promise<void>
  stop(): Promise<void>
}
```

adapter 负责平台登录、接收事件、校验、去重、协议转换和发送回复；它不应直接调用 DSH session、模型或工具。DSH API 只在 `src/dsh/` 中接线。

## 推荐顺序

1. 先写请求头、payload、响应解析、错误分类和 Markdown 转换等纯函数。
2. 注入 fetch、WebSocket 或回调 transport，用 fake transport 覆盖成功、超时、重复、限流和鉴权过期。
3. 实现 adapter，将平台事件转换为 `InboundMessage`，将 `OutboundMessage` 转回平台消息。
4. 在 `src/dsh/` 用 `ctx.effect` 绑定长轮询、socket、timer 和回调服务的生命周期。
5. 在 Web 设置中只展示非敏感状态；凭证、签名密钥和上下文 token 不进入 Client。

## 并发与可靠性

- 用平台消息 ID 去重。
- 同一平台会话按接收顺序处理，不同账号或会话使用独立队列。
- `/stop`、`/home`、`/setting` 等命令由 Router 处理，不发送给模型。
- 输入状态必须在 `finally` 中关闭。
- 网络错误、限流、会话过期、消息不支持和关闭流程要分别分类。

## 测试清单

- 正常文本收发、空文本和非文本消息。
- 重复消息、乱序消息和超长文本。
- 超时、5xx、限流、鉴权过期和 AbortSignal。
- session store 原子写入、损坏恢复和重启恢复。
- 同一用户串行、不同用户并行。
- 卸载后无遗留 timer、socket 或请求。
- 敏感字段不出现在日志和前端响应。

新增平台的 Pull Request 应同时更新路线图、协议文档、fake transport 测试和 README。
