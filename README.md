# PingCode MCP

PingCode Wiki 唯讀 MCP Server，讓 Coding Agent 從 PingCode Wiki 取得可追溯的 Markdown
上下文。MCP Server 只負責認證、查詢、驗證與資料標準化；需求理解、Spec Kit 與程式碼生成
仍由你的 Coding Agent 負責。

## 支援的工具

- `pingcode_wiki_list_spaces`
- `pingcode_wiki_list_pages`
- `pingcode_wiki_get_requirement_context`

所有第一階段工具都是唯讀。每次取得 Wiki 頁面時會保留來源 URL、頁面 ID、取得時間與內容
Hash，方便在技術規格或程式碼變更中追溯來源。

## 開始使用

需要 Node.js 20 或以上版本，以及已在 PingCode 建立的應用程式憑據。

### 本機 stdio

適合單一受信任使用者，以企業應用憑據存取 PingCode：

```bash
npm install
cp .env.stdio.local.example .env
# 編輯 .env，填入 PINGCODE_CLIENT_ID 與 PINGCODE_CLIENT_SECRET
npm run build
node /absolute/path/to/pingcode-mcp/dist/index.js --stdio
```

MCP Client 應直接啟動 `node` 及編譯後的 `dist/index.js`，避免 npm 輸出干擾 stdio 協議。
可參考 `examples/clients/vscode.mcp.example.json`。

### HTTP User OAuth

適合多使用者、Cursor、VS Code 或其他支援 MCP OAuth 的 Client。Docker Compose 會啟動 Redis，
保存加密後的 OAuth Session，讓服務重啟及多 instance 部署不必讓每位使用者重新登入。

```bash
cp .env.compose.local.example .env.compose.local
# 編輯 .env.compose.local，填入 User OAuth Client ID、Secret 與加密金鑰
COMPOSE_MCP_ENV_FILE=.env.compose.local docker compose up --build
```

在 PingCode OAuth 應用中，把 callback 設為：

```text
http://localhost:3000/auth/pingcode/callback
```

接著將 `http://localhost:3000/mcp` 加入 MCP Client。第一次連線時，Client 會開啟瀏覽器，
由使用者登入自己的 PingCode 帳戶。HTTP 範例見
`examples/clients/vscode-http-oauth.mcp.example.json`。

## 驗證

```bash
npm run typecheck
npm test
npm run build
```

健康檢查：`GET /health/live` 與 `GET /health/ready`。

## 安全與部署

- 不要提交 `.env`、Client Secret、Access Token、Cookie 或任何客戶 Wiki 正文。
- HTTP 服務預設只綁定本機。正式環境需使用 HTTPS，並放在客戶的 API Gateway、Service Mesh
  或等效企業認證與流量控制措施之後。
- 正式環境請使用客戶自己的 Secret Manager 與 Managed Redis；UAT 與 Production 必須使用不同
  的 PingCode 憑據。
- `enterprise` HTTP 模式不含入站使用者登入，不可直接對公網開放。

## 範圍

此專案目前只支援 PingCode Wiki 唯讀存取，不會建立或修改 PingCode 資料，也不提供任意
PingCode REST API 代理。未來若加入工作項目或 Test Case 寫入，會以獨立權限與審批流程提供。
