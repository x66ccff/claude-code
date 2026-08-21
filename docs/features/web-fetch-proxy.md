# WebFetch 专用 VPN 代理

Claude Code 原生 `WebFetch` 使用独立 Axios 客户端，可以选择直连、继承标准代理
环境变量，或使用专门配置的 HTTP(S) 代理。该设置只影响 WebFetch 的域名预检和
网页下载，不会改变模型厂商 API、WebSearch、MCP 或其他 Claude Code 网络请求。

## 配置

| 环境变量 | 行为 |
|---|---|
| 未设置 `CLAUDE_CODE_WEB_FETCH_PROXY` | 默认直连 |
| `CLAUDE_CODE_WEB_FETCH_PROXY=direct` | WebFetch 直连 |
| `CLAUDE_CODE_WEB_FETCH_PROXY=inherit` | 继承 `HTTPS_PROXY` / `HTTP_PROXY` |
| `CLAUDE_CODE_WEB_FETCH_PROXY=http://127.0.0.1:7890` | 使用指定 HTTP(S) 代理 |
| `CLAUDE_CODE_WEB_FETCH_NO_PROXY=...` | 添加 WebFetch 专用绕过域名或地址 |

默认绕过 `localhost`、`127.0.0.1`、`::1`，并读取本机已有的 `NO_PROXY` 和
`LAN_IP_*` 地址。显式配置的代理不可用时请求不会静默直连，而会提示检查代理；需要临时
绕过时显式设置 `CLAUDE_CODE_WEB_FETCH_PROXY=direct`。

实现入口：

- `packages/builtin-tools/src/tools/WebFetchTool/webFetchProxy.ts`
- `packages/builtin-tools/src/tools/WebFetchTool/utils.ts`
- `src/utils/proxy.ts` 中的 `createAxiosInstanceForProxy()`
