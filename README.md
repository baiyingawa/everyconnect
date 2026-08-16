# EveryConnect DSH Plugin

EveryConnect 是一个 DSH 多平台连接插件项目，用于把微信 Claw/iLink Bot 以及后续连接方式接入 DSH 的会话与 AI 能力。

当前状态：M0 工程骨架、M1 纯协议层、M2 生命周期接线、Web 设置页、微信二维码登录、DSH 会话菜单以及微信音频/文件接收已完成。

## 当前目标

第一阶段覆盖微信 Claw 文本、音频和文件消息闭环：

```text
微信用户
  -> iLink Bot 二维码登录
  -> getupdates 长轮询
  -> DSH Host 统一消息入口
  -> 工作区-任务会话菜单 / DSH Agent/LLM
  -> sendmessage 回复微信
```

微信首次发消息、发送 `/`，或处于未选定会话状态时，会收到按工作区排列的任务会话菜单。每页最多 20 个会话，使用 `/next` 和 `/prev` 翻页，发送编号进入会话；进入后消息会转发给对应 DSH 会话，助手回复会同步回微信。发送 `/exit` 或 `/home` 返回菜单。

微信语音和文件会先从 iLink CDN 下载并解密到 `~/.dsh/everyconnect/inbox/<message-id>/`，再把本地路径交给 DSH 会话。语音消息同时携带微信已有的语音转写；没有转写时，DSH 可根据本地音频文件继续处理。文件保留微信原文件名和 MIME 类型。

回复保留微信支持的 `**粗体**`、`*斜体*`、`~~删除线~~` 和 `` `行内代码` ``；链接、标题、引用和围栏代码会转换为适合微信显示的文本。

项目按 DSH 插件规范预留了以下入口：

- `package.json`：插件元数据、bundle patch 和 Web client 声明。
- `cordis.patch.yml`：稳定的 Cordis 插件行。
- `src/`：后续 Host 与 Client 实现。
- `docs/`：协议、架构和决策记录。

Web 设置页已注册到 DSH 的 `settings.section`，包含微信 Claw 开关、二维码登录、iLink 地址、session 存储路径和允许用户列表；配置暂存于浏览器 localStorage，Host 连接器通过 web server 提供二维码启动、状态和取消路由。

Web Client 构建为 DSH `__ModuleLoader__.load` 工厂格式，注册 id 为 `everyconnect`，兼容二次开发 desktop 的 client-modules loader。

## 命令

| 命令 | 作用 |
| --- | --- |
| `/` | 打开工作区-任务会话菜单 |
| `/help` | 查看命令指引 |
| `/new` | 新建工作目录或任务 |
| `/setting` | 查看整体设置；进入会话后查看会话设置 |
| `/config` | 查看当前会话、模型、模式、耗时和缓存统计 |
| `/stop` | 暂停当前任务 |
| `/next`、`/prev` | 翻页浏览任务会话 |
| `/back`、`/chat` | 返回菜单或当前聊天 |
| `/exit`、`/home` | 退出当前会话并返回首页 |

`/new workspace` 会先询问父目录，再询问新目录名称；`/new task` 会列出已登记的工作目录，创建任务后自动进入。新任务名称会同步到 DSH 会话标题。

## 快速开始

环境要求：Node.js `>=22.19.0`、pnpm `11.19.0` 和支持第三方插件的 DSH Desktop。

```bash
pnpm install
pnpm typecheck
pnpm test
pnpm build
pnpm pack --pack-destination dist
dsh plugin --profile desktop add ./dist/everyconnect-0.4.3.tgz
dsh --profile desktop
```

启动后进入 EveryConnect 设置，开启微信 Claw 连接器，点击“打开二维码”扫码登录。登录凭证、更新游标和上下文 token 由 Host 侧持久化，不进入前端状态和普通日志。

## 架构边界

```text
微信 / QQ / 企业微信
  -> PlatformAdapter
  -> 平台协议与消息转换
  -> InboundMessage / OutboundMessage
  -> DSH Router
  -> session / model / tools
  -> 平台回复与输入状态
```

- `src/platform/`：平台无关接口和类型，不依赖 DSH。
- `src/wechat/`：微信 iLink 协议、二维码、HTTP 和持久化适配。
- `src/dsh/`：唯一的 DSH Host 接线层、生命周期、路由和 Web API。
- `src/client/`：DSH 设置页和客户端状态展示。
- `tests/`：fake transport、协议、适配器和并发路由测试。

同一来源的消息按顺序处理，不同来源使用独立队列；所有网络请求、长轮询和输入状态都绑定生命周期并可取消。

## 文档索引

- [项目计划](./PROJECT_PLAN.md)
- [架构草案](./ARCHITECTURE.md)
- [微信 iLink 协议适配说明](./docs/WECHAT_ILINK_PROTOCOL.md)
- [平台适配器开发指南](./docs/PLATFORM_ADAPTER_GUIDE.md)
- [版本路线图](./docs/ROADMAP.md)
- [贡献指南](./CONTRIBUTING.md)
- [变更记录](./CHANGELOG.md)

## 设计边界

- 微信登录凭证、`get_updates_buf` 和 `context_token` 由插件自己的持久化服务管理。
- AI 请求优先复用 DSH 的模型与会话能力，不在插件内复制一套 AI provider 客户端。
- 网络适配器与 DSH 会话路由解耦，后续可增加企业微信和其他平台连接器。
- 默认不把 API token 写入日志、session event 或前端状态。
- 单元测试使用 fake transport；真实微信网络调用放到显式 smoke test。

## 参考

- 本地参考工程：`E:\PROJECT\wechat-ai-bridge`
- DSH 插件开发指南：`E:\PROJECT\dsh-plugin\DSH_PLUGIN_DEVELOPMENT_GUIDE.md`
