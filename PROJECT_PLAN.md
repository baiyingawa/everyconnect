# 项目计划：EveryConnect DSH Plugin

## 1. 项目定位

目标是开发一个名为 EveryConnect 的 DSH 多平台连接插件。插件负责平台接入、身份与消息转换、生命周期管理；DSH 负责会话、模型调用、工具和 Web 展示。

首个连接器为微信 Claw/iLink Bot。企业微信及其他 AI 信息支持平台属于后续连接器，不在第一阶段实现。

## 2. 已确认与待验证

### 已确认

| 编号 | 内容 | 依据 |
| --- | --- | --- |
| E1 | DSH 独立插件使用 npm manifest、`dsh.bundle.patch` 和 `cordis.patch.yml` 接入 | `DSH_PLUGIN_DEVELOPMENT_GUIDE.md` 第 2、3 节 |
| E2 | DSH 插件可注册 Host 服务、工具、事件，并可提供 Web client | `DSH_PLUGIN_DEVELOPMENT_GUIDE.md` 第 1、4 节 |
| E3 | 参考工程使用二维码登录，再通过 iLink Bot `getupdates` 长轮询收消息 | `wechat_client.py` 的 `get_qrcode`、`poll_qrcode_status`、`get_updates` |
| E4 | 参考工程通过 `context_token` 关联回复，并使用 `sendmessage` 发送文本 | `wechat_client.py` 的 `send_text_message` |
| E5 | 参考工程持久化 bot token、用户标识、更新游标和上下文 token | `session_store.py` |

### 待验证

| 编号 | 问题 | 验证时机 |
| --- | --- | --- |
| U1 | 目标 DSH 版本中实际可用的 session 路由 API 与事件类型 | 第一个 Host spike |
| U2 | DSH 是否允许插件直接注册后台长轮询 job，以及 job 的取消语义 | 生命周期测试 |
| U3 | iLink Bot 消息中的群聊、非文本 item、重复投递和顺序保证 | fake payload + smoke test |
| U4 | DSH Web client 是否需要对话节点，还是先使用 Host 工具/命令 | 第一版交互原型 |
| U5 | 真实接口的限流、错误码和登录凭证过期行为 | 独立网络 smoke test |

## 3. 第一阶段范围

### 必须完成

1. 插件能被 DSH profile 识别并加载。
2. 提供微信连接配置校验，不打印敏感凭证。
3. 实现二维码登录状态机，并持久化登录结果。
4. 实现可取消的 `getupdates` 长轮询循环。
5. 只接收用户文本消息，转换为统一的 inbound message。
6. 把回复转换成 iLink `sendmessage` 文本消息。
7. 处理 session 过期、网络错误、空轮询、重复消息和优雅关闭。
8. 为核心协议适配和路由写 fake transport 单元测试。

### 暂不实现

- 企业微信连接器。
- 图片、文件、语音、位置和富媒体双向转换。
- 多账号管理界面。
- 在插件内部实现新的 AI provider。
- 自动化扫码 UI。
- 复杂的 Web 对话节点和管理后台。

## 4. 里程碑

### M0：骨架与契约

- 保留当前 manifest、Cordis patch 和文档结构。
- 确认 DSH 版本、Node/pnpm 版本和 TypeScript 构建方式。
- 建立统一平台接口：`PlatformAdapter`、`InboundMessage`、`OutboundMessage`。

完成条件：插件可 typecheck/build，且空实现可加载。

### M1：微信连接器

- `WechatClawClient`：HTTP 请求、二维码登录、长轮询、发文本、输入状态。
- `WechatSessionStore`：敏感凭证与游标的原子读写。
- 明确 timeout、retry、backoff、abort 和错误分类。

完成条件：所有网络请求可由 fake transport 驱动，核心状态机测试通过。

### M2：DSH 路由

- 把微信消息映射到 DSH 会话。
- 回复按原始平台会话和 `context_token` 回传。
- 对并发消息定义顺序策略和幂等键。

完成条件：本地 fake DSH + fake 微信完成一进一出及异常流程。

### M3：真实 smoke test

- 临时 profile 安装 tarball。
- 二维码登录、发送一条文本、收到回复、重启恢复。
- 验证 session 过期后的重新登录提示。

完成条件：记录 DSH 版本、配置摘要、步骤结果和可复现命令。

### M4：Web Client 与平台抽象增强

- 只在有明确用户需求时增加设置面板或会话节点。
- 复用统一平台接口增加企业微信连接器。

完成条件：新增连接器不复制微信特有的会话与路由逻辑。

## 5. 配置草案

```yaml
wechat:
  enabled: false
  base_url: "https://ilinkai.weixin.qq.com"
  channel_version: "1.0.2"
  long_poll_timeout_ms: 35000
  request_timeout_ms: 15000
  reconnect_backoff_ms: 3000
  session_store: "~/.dsh/everyconnect/session.json"
  allow_from: []
  deny_from: []
```

凭证不进入此配置示例；登录得到的 token 与会话状态进入受限文件或宿主提供的 secret store。`channel_version` 与默认超时是参考工程值，最终以真实接口验证为准。

## 6. 风险与决策

| 风险 | 影响 | 决策 |
| --- | --- | --- |
| DSH developer preview API 变化 | 插件加载或路由失效 | 将 DSH 依赖集中在 adapter 层，并建立兼容矩阵 |
| 长轮询阻塞插件卸载 | profile 无法干净退出 | 所有请求绑定 `AbortSignal`，dispose 时取消 job |
| 更新游标丢失导致重复消息 | 重复调用模型 | 先持久化可恢复游标，再以消息 id 做幂等去重 |
| context token 过期 | 回复失败 | 按会话缓存并在错误时重新获取，不把 token 暴露给 Client |
| 平台消息类型扩张 | 路由逻辑复杂 | 第一阶段显式跳过非文本 item，并返回可观测原因 |

## 7. 代码目录目标

```text
everyconnect/
├─ package.json
├─ cordis.patch.yml
├─ README.md
├─ PROJECT_PLAN.md
├─ ARCHITECTURE.md
├─ docs/
│  └─ WECHAT_ILINK_PROTOCOL.md
├─ src/
│  ├─ index.ts
│  ├─ client.ts
│  ├─ platform/
│  ├─ wechat/
│  ├─ session/
│  └─ dsh/
├─ tests/
└─ lib/
```

## 8. 下一步实现顺序

1. 用当前目标 DSH 安装包确认 `Context`、`tools`、session 和 job 的实际类型。
2. 建立协议纯函数：headers、二维码状态转换、消息提取、sendmessage payload。
3. 建立 fake transport 和状态机测试。
4. 再接入真实 HTTP 与 DSH 生命周期。
5. 最后决定是否需要 Web Client。

## 9. 当前实现进度

- M0：已完成 TypeScript/tsdown/Vitest 工具链、Git 初始化、Host/Client 构建入口。
- M1：已完成协议纯函数、注入式 fetch 客户端、错误分类、原子 session store 和 fake transport 测试。
- M2：已完成长轮询 adapter、`ctx.effect` 生命周期辅助、Web 服务延迟注入辅助和原始 JSON Schema 工具辅助。
- Web Client：已按 dshmarket 的 `settings.section` 契约注册 EveryConnect 设置页，并注入 locale、settings、runtime、theme 客户端模块。
- 未完成：真实二维码登录循环、目标 DSH runtime 的 session/jobs/events 精确接线、真实微信 smoke test。
