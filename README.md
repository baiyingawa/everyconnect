# EveryConnect DSH Plugin

EveryConnect 是一个 DSH 多平台连接插件项目，用于把微信 Claw/iLink Bot 以及后续连接方式接入 DSH 的会话与 AI 能力。

当前状态：M0 工程骨架、M1 纯协议层、M2 生命周期接线辅助和 Web 设置页已完成；真实二维码登录和 DSH 运行时配置仍待 smoke test。

## 当前目标

第一阶段只覆盖微信 Claw 文本消息闭环：

```text
微信用户
  -> iLink Bot 二维码登录
  -> getupdates 长轮询
  -> DSH Host 统一消息入口
  -> DSH Agent/LLM
  -> sendmessage 回复微信
```

项目按 DSH 插件规范预留了以下入口：

- `package.json`：插件元数据、bundle patch 和 Web client 声明。
- `cordis.patch.yml`：稳定的 Cordis 插件行。
- `src/`：后续 Host 与 Client 实现。
- `docs/`：协议、架构和决策记录。

Web 设置页已注册到 DSH 的 `settings.section`，包含微信 Claw 开关、iLink 地址、session 存储路径和允许用户列表；配置暂存于浏览器 localStorage，Host 连接器接线后再迁移到宿主设置服务。

## 文档索引

- [项目计划](./PROJECT_PLAN.md)
- [架构草案](./ARCHITECTURE.md)
- [微信 iLink 协议适配说明](./docs/WECHAT_ILINK_PROTOCOL.md)

## 设计边界

- 微信登录凭证、`get_updates_buf` 和 `context_token` 由插件自己的持久化服务管理。
- AI 请求优先复用 DSH 的模型与会话能力，不在插件内复制一套 AI provider 客户端。
- 网络适配器与 DSH 会话路由解耦，后续可增加企业微信和其他平台连接器。
- 默认不把 API token 写入日志、session event 或前端状态。
- 单元测试使用 fake transport；真实微信网络调用放到显式 smoke test。

## 参考

- 本地参考工程：`E:\PROJECT\wechat-ai-bridge`
- DSH 插件开发指南：`E:\PROJECT\dsh-plugin\DSH_PLUGIN_DEVELOPMENT_GUIDE.md`
