# Changelog

## 0.4.3 - 2026-08-17

- 增加微信语音和文件消息接收，支持 iLink CDN 下载、AES-128-ECB 解密和本地落盘。
- 将附件路径、MIME 类型及语音转写交给对应 DSH 任务会话。
- 增加音频/文件协议解析、媒体下载解密和媒体存储测试。
- 在首页和 `/help` 命令提示中明确展示 `/new`、`/new workspace` 和 `/new task`。
- 合并短时间内的 assistant 流式分片，减少微信消息 IO。
- 避免任务名在每个 token 消息顶部重复发送。
- 增加流式分片批处理和最终消息补发测试。
- 微信收到消息后不再等待 DSH 处理完成才进入下一轮长轮询。
- 增加消息分发不阻塞轮询的适配器测试。

## 0.4.2 - 2026-08-17

- 增加 `/new` 菜单。
- 支持通过 Host `createDirectory` 和 `workspace.create` 新建工作目录。
- 支持通过 `session.create` 和 `session.rename` 新建任务并自动进入。
- 增加新建流程取消、输入校验和 fake Host API 测试。

## 0.4.1 - 2026-08-17

- 增加微信工作区-任务会话菜单、分页、设置、配置统计和 `/stop`。
- 增加 assistant 实时输出、合并发送设置、输入中状态和多用户并发队列。
- 修复二次开发 desktop 的 client-modules loader、二维码展示和重复回复问题。

## 0.2.1 - 2026-08-16

- 建立微信 iLink Bot 连接器、DSH Host 接线、协议纯函数和 fake transport 测试。
