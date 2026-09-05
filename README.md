# iamalive

個人用旅行報平安：一鍵打卡、家人群組 LINE 通知、逾時警報、雙時區家人頁。規格見 [`docs/spec.md`](docs/spec.md)（v0.9）。

```
functions/   Cloud Functions（api、lineWebhook、checkOverdue）
web/         家人頁 /w/{token} 與管理頁 /me（Vite + Leaflet + Firebase Web SDK）
shortcuts/   iOS 捷徑定義（主要打卡入口）
docs/        規格書
```

## 一次性設定

### 1. Firebase

1. 建立專案，升級 **Blaze**，設定預算告警。
2. 啟用 Firestore（Native，`asia-east1`）。
3. 新增 Web App，取得 SDK 設定。
4. 把 `.firebaserc` 的 `YOUR_FIREBASE_PROJECT_ID` 換成專案 ID。

### 2. LINE 官方帳號與 LINE Login

同一個 **Provider** 底下要有兩個 channel：Messaging API（推播、webhook）與 LINE Login（`/me` 登入）。**必須同一個 Provider**，兩邊拿到的 userId 才一致。

#### 2a. LINE Login channel（`/me` 登入）

1. LINE Developers → 同一個 Provider → 新增 **LINE Login** channel，App types 勾 Web app。
2. Callback URL 填 `https://<host>/api/auth/line/callback`。
3. 記下 **Channel ID**（填 `functions/.env` 的 `LINE_LOGIN_CHANNEL_ID`）與 **Channel secret**（Secret `LINE_LOGIN_CHANNEL_SECRET`）。
4. 同一個 channel → **LIFF** 分頁 → 新增：Endpoint URL `https://<host>/me`、Size Full、Scopes `openid` + `profile`、Bot link feature On (normal)。LIFF ID 填 `web/.env` 的 `VITE_LIFF_ID` 與 `functions/.env` 的 `LIFF_ID`。管理頁從 LINE 內開 `https://liff.line.me/<LIFF ID>` 會自動登入（可放進官方帳號的圖文選單）。

#### 2b. Messaging API channel（官方帳號）

1. [LINE Developers](https://developers.line.biz/)：建立 Provider → **Messaging API channel**。
2. LINE Official Account Manager → 設定 → 回應設定：關閉自動回應與加入好友歡迎訊息；**開啟「允許加入群組・多人聊天室」**。
3. Developers Console → Messaging API 分頁：發行 **Channel access token（長效）**；記下 **Channel secret**。
4. 部署後（步驟 4）回來設定 **Webhook URL** 為 `lineWebhook` 的 Functions URL，並啟用 Use webhook。

### 3. Secrets 與環境變數

```bash
firebase functions:secrets:set LINE_CHANNEL_SECRET          # Messaging API
firebase functions:secrets:set LINE_CHANNEL_ACCESS_TOKEN    # Messaging API 長效 token
firebase functions:secrets:set LINE_LOGIN_CHANNEL_SECRET    # LINE Login
openssl rand -base64 48 | firebase functions:secrets:set SESSION_SECRET --data-file -   # session 簽章金鑰
firebase functions:secrets:set RAPIDAPI_KEY                 # 選填：AeroDataBox 航班查詢（RapidAPI）

cp functions/.env.example functions/.env             # 填 PUBLIC_BASE_URL、PHOTO_BUCKET、LINE_LOGIN_CHANNEL_ID
cp web/.env.example web/.env                         # 填 Firebase Web 設定與 MapTiler key
```

### 3.1 照片 bucket

照片存在一個**私有** GCS bucket，不用 Firebase Storage 預設 bucket。建立後把名稱填進 `functions/.env` 的 `PHOTO_BUCKET`，並授權 Functions 的服務帳號（`<專案編號>-compute@developer.gserviceaccount.com`）`roles/storage.objectAdmin`。用 gcloud：

```bash
gcloud storage buckets create gs://<專案ID>-photos --location=asia-east1 --uniform-bucket-level-access --public-access-prevention
gcloud storage buckets add-iam-policy-binding gs://<專案ID>-photos --member=serviceAccount:<專案編號>-compute@developer.gserviceaccount.com --role=roles/storage.objectAdmin
```

### 4. 部署

```bash
cd functions && npm install && npm test && cd ..
cd web && npm install && cd ..
firebase deploy --only firestore,functions,hosting
```

（不部署 `storage` 規則：照片 bucket 不是 Firebase 預設 bucket，規則檔只給 emulator 用。）部署輸出會列出 `lineWebhook` 的 URL，填回 LINE Developers 的 Webhook URL。

### 5. 登入、綁定群組、產生金鑰

1. 在 LINE 內開 `https://liff.line.me/<LIFF ID>`（自動登入），或用瀏覽器開 `https://<host>/me` → 「用 LINE 登入」。
2. 把官方帳號邀請進家人群組，回到 `/me` 按「產生綁定碼」，由你本人在群組輸入「綁定 123456」。bot 回「✅ 綁定完成」。
3. `/me` → 捷徑金鑰 → 產生一把，複製到捷徑的 `X-Api-Key`（只顯示一次；可隨時撤銷重發）。

每位用 LINE 登入的人都有自己的行程、群組綁定與金鑰；推播額度（免費 200 則/月）為整個官方帳號共用。

### 6. 捷徑

兩種擇一或並用：
- **主畫面捷徑（最簡單）**：`/me` → 參數設定 → 打卡頁，用 Safari 開啟連結 → 分享 → 加入主畫面。點圖示就能定位或拍照打卡，不需登入；連結外洩就在同一張卡片按「輪替」。
- **iOS 捷徑 App**：依 [`shortcuts/README.md`](shortcuts/README.md) 建立捷徑 A（必要）、B、C、D，可搭配自動化。

## 日常使用

1. `/me` 用 LINE 登入後建立行程（群組收到「行程開始」與家人頁連結；家人頁只有這一條連結）。
2. 出門後點主畫面的打卡頁圖示或按捷徑 A 打卡；或**直接在 LINE 私訊官方帳號傳送「位置」**，也算一次打卡；先傳照片再傳位置（15 分鐘內）會記成含照片的打卡。打卡不推群組；家人看家人頁，或在群組輸入「在哪」「行程」。
3. 長途飛行前按捷徑 C 或在群組輸入 `離線 16`。打錯卡：`/me` 打卡管理刪除，或私訊 `刪除最後一筆`。行程中要改打卡頻率：`/me` 行程管理，或輸入 `頻率 6`（期限立即重算）。
4. 回報期限前 1 小時，官方帳號會私訊提醒你本人（要先加 @574stmif 為好友；每個期限一次）。
5. 逾時未打卡：群組收到警報，每 3 小時重複、最多 4 次；台北 23:00–07:00 發出的警報會在 08:00 補發一次。
6. 回家後 `/me` 結束行程，或在群組輸入 `結束`。忘了的話結束時間 24 小時後自動結案。

## 開發

```bash
cd functions && npm run typecheck && npm test   # 純函式單元測試
cd functions && npm run e2e                      # emulator 端到端（需 Java 與 firebase CLI）
cd web && npm run typecheck && npm run build
firebase emulators:start        # Functions + Firestore + Hosting（需先 build）
```

`npm run e2e` 會在離線的 demo 專案上跑完整 API 流程與逾時狀態機，首次執行會產生 `functions/.secret.local`（測試用假值，已 gitignore）。

`checkOverdue` 的決策邏輯在 `functions/src/overdue-logic.ts`，為純函式，測試在 `functions/test/`。
