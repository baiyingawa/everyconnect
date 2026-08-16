# 贡献指南

## 环境

- Node.js `>=22.19.0`
- pnpm `11.19.0`
- 支持第三方插件的 DSH Desktop

```bash
pnpm install
pnpm typecheck
pnpm test
pnpm build
```

提交前运行类型检查、单元测试和构建。真实平台请求放在手动 smoke test，默认测试使用 fake transport。

## 代码边界

- `src/platform/` 不依赖 DSH。
- `src/wechat/`、`src/qq/` 等目录只处理平台协议。
- `src/dsh/` 是唯一的 DSH 接线层。
- Client 不导入 Node 内置模块，不读取凭证和本地文件。
- fetch、WebSocket、timer 和后台循环必须可取消并可清理。

## Pull Request

请说明变更目的、影响范围、协议依据、测试命令和未验证项。新增平台至少应包含协议文档、fake transport、生命周期测试和 README/路线图更新。

不要提交 token、二维码 URL、context token、真实聊天内容、`node_modules/`、`lib/`、`dist/` 或 `.tgz`。
