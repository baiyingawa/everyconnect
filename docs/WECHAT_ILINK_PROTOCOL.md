# 微信 iLink Bot 协议适配说明

本文件只记录本地参考工程中已经出现的协议形状，以及接入 DSH 时需要验证的边界。参考工程路径：`E:\PROJECT\wechat-ai-bridge`。

## 1. 已观察到的端点

| Endpoint | Method | 用途 |
| --- | --- | --- |
| `/ilink/bot/get_bot_qrcode?bot_type=3` | POST | 获取二维码内容和轮询 token |
| `/ilink/bot/get_qrcode_status` | GET | 长轮询二维码状态 |
| `/ilink/bot/getupdates` | POST | 长轮询新消息 |
| `/ilink/bot/sendmessage` | POST | 发送文本 |
| `/ilink/bot/getconfig` | POST | 获取 typing ticket |
| `/ilink/bot/sendtyping` | POST | 更新输入状态 |

默认 base URL 为 `https://ilinkai.weixin.qq.com`，应允许配置覆盖。

## 2. 请求头

参考工程为业务请求设置：

```text
Content-Type: application/json
AuthorizationType: ilink_bot_token
Authorization: Bearer <bot_token>
X-WECHAT-UIN: <base64(random uint32 decimal string)>
```

token 只能在 Host 内存和受限 session store 中使用，不传入 DSH Client。

## 3. 登录状态机

```text
REQUEST_QR
  -> WAIT_SCAN
  -> SCANNED
  -> CONFIRMED
  -> SAVE_SESSION

WAIT_SCAN -> EXPIRED | CANCELED | REJECTED
```

确认状态中参考工程读取：`bot_token`、`ilink_bot_id`、`ilink_user_id`、`baseurl`。任何必需字段缺失都应转为登录失败，而非写入半成品 session。

## 4. getupdates 请求与响应

请求的已知形状：

```json
{
  "get_updates_buf": "<cursor>",
  "base_info": {
    "channel_version": "1.0.2"
  }
}
```

响应中参考工程读取：

```text
errcode
get_updates_buf
longpolling_timeout_ms
msgs[]
```

`errcode == -14` 被视为 session 过期。消息中的 `context_token` 按 `from_user_id` 缓存，供后续回复使用。

## 5. 文本消息提取

参考工程仅处理：

```text
message_type == 1       # USER
item.type == 1           # TEXT
item.text_item.text      # 文本内容
from_user_id             # 发送者
context_token            # 回复上下文
```

多项文本 item 以换行拼接。没有发送者或文本时跳过。第一阶段对其他 item 类型只做可观测跳过，不猜测其媒体协议。

## 6. sendmessage 请求

已观察到的文本 payload：

```json
{
  "msg": {
    "to_user_id": "<user_id>",
    "client_id": "<uuid-without-dashes>",
    "message_type": 2,
    "message_state": 2,
    "context_token": "<latest_context_token>",
    "item_list": [
      {
        "type": 1,
        "text_item": {
          "text": "<reply>"
        }
      }
    ]
  },
  "base_info": {
    "channel_version": "1.0.2"
  }
}
```

`client_id` 用于一次发送的幂等/追踪，生成策略和重复发送行为需要真实接口验证。

## 7. typing

参考工程先调用 `getconfig` 得到 `typing_ticket`，再调用 `sendtyping`。输入状态值为 `1`，结束状态值为 `2`。这两步均应设置短 timeout，并在取消、异常和回复完成时执行关闭逻辑。

## 8. 待验证协议项

- HTTP 状态码与 JSON `errcode` 的组合规则。
- `msgs` 是否可能包含重复消息、空消息或机器人回显。
- 群聊消息的 sender/conversation 字段。
- 文本长度上限和超长文本拆分规则。
- `context_token` 的有效期、覆盖规则和并发回复行为。
- `get_updates_buf` 的持久化时机及服务重启后的重复窗口。
- 二维码状态返回的全部枚举值与 `verify_code` 语义。
