# OpenCode to OpenAI API

把 OpenCode 的模型与会话 API 转换成 OpenAI-compatible Chat Completions API。

## 功能

- `GET /v1/models`
- `POST /v1/chat/completions`
- 普通与 SSE 流式响应
- `reasoning_effort` 和 `reasoning: { "effort": "high" }`
- 默认禁用全部 OpenCode 工具
- 外部 OpenAI function tools 桥接为 `tool_calls`
- 可选、严格白名单化的 OpenCode 内置 `webfetch`
- Bearer API Key、Docker Compose、自动启动 OpenCode 后端

## 本地运行

需要 Node.js 20.11+ 和已安装、已登录的 OpenCode：

```bash
npm install -g opencode-ai@1.18.5
opencode serve --hostname 127.0.0.1 --port 4096
```

另开一个终端：

```bash
cp .env.example .env
# 把 .env 中的值导入环境后：
npm start
```

Windows PowerShell 示例：

```powershell
$env:API_KEY = "YOUR_API_KEY"
$env:OPENCODE_BASE_URL = "http://127.0.0.1:4096"
$env:OPENCODE_DIRECTORY = "G:\your\workspace"
npm start
```

若 `opencode serve` 设置了 `OPENCODE_SERVER_PASSWORD`，代理进程必须使用相同变量；用户名默认为 `opencode`。

## Docker 一键部署

```bash
cp .env.example .env
docker compose up -d --build
```

Compose 会在同一个容器中自动启动 OpenCode 后端和兼容层。OpenCode 的配置和登录数据保存在命名卷中，工作目录由 `OPENCODE_WORKSPACE` 指定：

```bash
API_KEY=YOUR_API_KEY OPENCODE_WORKSPACE=/path/to/workspace docker compose up -d --build
```

镜像中安装的 OpenCode 版本可通过 `.env` 配置；修改后需要重新构建镜像：

```dotenv
OPENCODE_VERSION=1.18.29
```

```bash
docker compose up -d --build
```

需要登录其他 provider 时，可在容器中执行：

```bash
docker compose exec opencode-openai-api opencode auth login
```

如果宿主机已有 OpenCode 登录数据，可把 `docker-compose.yml` 中的命名卷改成对应宿主机目录的 bind mount。

## 调用

```bash
curl -X POST http://127.0.0.1:10000/v1/chat/completions \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "opencode/big-pickle",
    "messages": [{"role": "user", "content": "你好!"}],
    "stream": false
  }'
```

流式调用只需传 `"stream": true`，服务返回标准 `chat.completion.chunk` SSE，并以 `data: [DONE]` 结束。`stream_options: { "include_usage": true }` 会在结束前附加 usage chunk。

推理强度支持两种写法，最终映射到 OpenCode 的 model variant：

```json
{ "reasoning_effort": "high" }
```

```json
{ "reasoning": { "effort": "high" } }
```

具体模型是否生效取决于 `/v1/models` 中该模型的 `reasoning_efforts`。

## 外部工具桥接

外部客户端传入的工具不会注册或放行任何 OpenCode 同名内置工具。代理把模型生成的函数名和参数转换成标准 OpenAI `tool_calls`，客户端执行函数后再把结果传回模型。

工具桥接根据模型使用两种方式：

- 一般模型通过 OpenCode `StructuredOutput` 和 `format: json_schema` 生成工具决策。
- `opencode/deepseek*` 模型不使用 `format: json_schema`。代理会把工具定义和 JSON 响应约定写入提示词，完整生成后解析 `action=message` 或 `action=tool_calls`，再转换成 OpenAI 响应。这避免 DeepSeek 上游返回 `Error from provider (Console): Upstream request failed`。

两种方式都会校验工具名，只接受当前请求 `tools` 中声明的函数；不会因此启用 OpenCode 内置工具。

```bash
curl -X POST http://127.0.0.1:10000/v1/chat/completions \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "opencode/big-pickle",
    "messages": [{"role": "user", "content": "帮我获取 https://example.com 的标题"}],
    "tools": [{
      "type": "function",
      "function": {
        "name": "web_fetch",
        "description": "Fetch a URL and return its content summary",
        "parameters": {
          "type": "object",
          "properties": {"url": {"type": "string"}},
          "required": ["url"]
        }
      }
    }]
  }'
```

客户端执行函数后，按 OpenAI 规范把 assistant 的 `tool_calls` 和 `role: "tool"` 的结果一起放进下一次请求的 `messages`。

工具决策需要完整生成后才能确定，因此带外部 `tools` 的 SSE 请求仍使用标准 SSE 格式，但 `tool_calls` 通常在流末尾一次发出。DeepSeek 的 prompt JSON 桥接还会缓冲最终文本，解析完成后再一次发出，避免把内部 JSON 协议暴露给客户端。不带外部工具的普通文本请求仍是真正的 token/文本增量流。

DeepSeek 工具调用示例：

```json
{
  "model": "opencode/deepseek-v4-flash-free",
  "messages": [
    {"role": "user", "content": "查询上海天气，请使用可用工具"}
  ],
  "tools": [
    {
      "type": "function",
      "function": {
        "name": "get_weather",
        "description": "查询指定城市的当前天气",
        "parameters": {
          "type": "object",
          "properties": {
            "city": {"type": "string"}
          },
          "required": ["city"]
        }
      }
    }
  ],
  "tool_choice": "auto"
}
```

## 内置 webfetch

仅当请求**没有**传 `tools` 时，可以显式允许 OpenCode 内置 `webfetch`：

```json
{
  "model": "opencode/big-pickle",
  "messages": [{"role": "user", "content": "获取 https://example.com 的标题"}],
  "opencode": { "web_fetch": true }
}
```

也接受顶层 `"web_fetch": true` 或 `"enable_web_fetch": true`。该模式只放行 `webfetch`，其他 OpenCode 工具继续禁用；内置工具过程不会暴露为客户端 `tool_calls`，只返回最终答案。

## 配置

| 环境变量 | 默认值 | 说明 |
|---|---:|---|
| `API_KEY` | 空 | 外部 Bearer Key；空值表示不鉴权 |
| `HOST` / `PORT` | `0.0.0.0` / `10000` | 兼容层监听地址 |
| `OPENCODE_VERSION` | `1.18.5` | Docker 镜像中安装的 OpenCode 版本（仅构建时生效） |
| `OPENCODE_BASE_URL` | `http://127.0.0.1:4096` | OpenCode 服务地址 |
| `OPENCODE_DIRECTORY` | 当前目录 | 传给 OpenCode 的工作目录 |
| `OPENCODE_SERVER_USERNAME` | `opencode` | OpenCode Basic Auth 用户名 |
| `OPENCODE_SERVER_PASSWORD` | 空 | OpenCode Basic Auth 密码 |
| `OPENCODE_REQUEST_TIMEOUT_MS` | `600000` | 单次生成超时 |
| `CLEANUP_SESSIONS` | `true` | 请求结束后删除临时会话 |
| `MAX_BODY_BYTES` | `10485760` | 最大请求体 |

健康检查：`GET /health`。

## 当前兼容边界

实现目标是 Chat Completions 核心兼容。

- `temperature`、`top_p`、`max_tokens` 等 OpenAI 采样参数目前不会覆盖 OpenCode 的 provider/model 配置。
- 图片会在对话转录中作为 URL 提供给模型，而不是作为 OpenCode 原生附件上传。
- `opencode/deepseek*` 的外部工具支持依赖模型遵循提示词中的 JSON 响应约定。代理可兼容纯 JSON、Markdown JSON 代码块和被少量说明文字包围的 JSON；若无法解析为有效工具决策，会把模型原始文本作为普通回复返回。
- DeepSeek 带外部工具时需要缓冲完整文本，因此不提供逐 token 文本输出；不带工具时不受影响。
