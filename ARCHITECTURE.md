# 架构草案

## 1. 分层

```text
+-----------------------------------------------------------+
| DSH Host                                                 |
|  plugin lifecycle | session routing | agent/LLM | jobs   |
+---------------------------+-------------------------------+
                            |
                     Platform Router
                            |
+---------------------------v-------------------------------+
| WeChat Claw Adapter                                      |
| login | poll | parse | dedupe | reply | typing          |
+---------------------------+-------------------------------+
                            |
                     HTTP Transport
                            |
                 iLink Bot API endpoints
```

核心原则：微信适配器只处理平台协议；路由层只处理统一消息；DSH adapter 只处理 DSH 的真实扩展点。

## 2. 统一消息模型

```ts
type InboundMessage = {
  platform: 'wechat-claw'
  accountId: string
  conversationId: string
  senderId: string
  messageId: string
  text: string
  receivedAt: number
  replyContext?: {
    contextToken: string
  }
  rawType: 'text'
}

type OutboundMessage = {
  conversationId: string
  text: string
  replyContext?: {
    contextToken: string
  }
}
```

`raw` payload 不进入普通日志。需要排查协议时使用受控 debug 日志，并对 token、二维码内容和授权头脱敏。

## 3. 收消息流程

```text
start
  -> load session
  -> if missing/expired: request QR
  -> poll QR status
  -> save bot credentials atomically
  -> start cancellable getupdates loop
  -> update cursor and context token
  -> discard non-user/non-text messages
  -> dedupe by platform message id
  -> map to InboundMessage
  -> route to DSH session
```

每轮长轮询的游标更新应在响应结构校验后进行。网络超时是正常空结果；鉴权过期进入 `SESSION_EXPIRED`；其他错误使用有限退避并保持可观测性。

## 4. 发消息流程

```text
DSH response
  -> resolve original platform conversation
  -> load latest context token
  -> validate text and size policy
  -> build sendmessage payload
  -> send with request timeout
  -> classify response
  -> record success/failure without token values
```

输入状态是独立能力：发送前启用，完成或异常时关闭，使用 `finally` 保证清理。

## 5. 状态与持久化

建议的逻辑字段：

```text
auth.botToken
auth.ilinkBotId
auth.ilinkUserId
auth.baseUrl
cursor.getUpdatesBuf
cursor.longPollingTimeoutMs
conversations[conversationId].contextToken
metadata.createdAt
metadata.lastActiveAt
metadata.sessionExpired
```

文件写入要求：先写临时文件、flush、替换目标文件；读取失败时返回明确的 `SESSION_STORE_CORRUPT`，不静默覆盖旧状态。

## 6. 错误分类

| 分类 | 例子 | 行为 |
| --- | --- | --- |
| `CONFIG_INVALID` | URL、超时或 allowlist 无效 | 启动时阻止连接 |
| `AUTH_REQUIRED` | 没有 bot token | 进入二维码登录 |
| `SESSION_EXPIRED` | getupdates 返回过期错误 | 停止轮询并重新登录 |
| `NETWORK_RETRYABLE` | timeout、暂时断网、5xx | 退避重试 |
| `PAYLOAD_INVALID` | 缺少用户、文本或 context token | 丢弃并记录原因 |
| `MESSAGE_UNSUPPORTED` | 非文本 item | 跳过并记录类型 |
| `DSH_ROUTE_FAILED` | DSH 会话调用失败 | 关闭输入状态并尝试错误回复 |
| `SHUTDOWN` | dispose、AbortSignal 或进程退出 | 取消请求并释放资源 |

## 7. 生命周期

所有长轮询、定时器、文件 watcher、事件监听和后台 job 都必须绑定 Cordis fiber。dispose 顺序：

1. 标记 adapter stopping。
2. abort 当前 HTTP 请求。
3. 等待轮询 job 结束。
4. 停止输入状态和重试计时器。
5. 关闭 session store 句柄。

## 8. 安全与可观测性

- 日志允许记录 endpoint、状态码、耗时、错误分类和平台 message id 的哈希。
- 日志禁止记录 bot token、Authorization、context token、二维码 URL 和完整消息正文。
- 配置支持 allowlist/denylist，默认不把所有新用户自动转入 DSH 会话。
- 指标建议包括轮询成功率、消息解析数、重复数、AI 路由耗时、回复失败数和登录过期数。
