# iamalive

個人用旅行報平安：一鍵打卡、家人群組 LINE 通知、逾時警報、雙時區家人頁。規格見 [`docs/spec.md`](docs/spec.md)（v0.4）。

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

### 2. LINE 官方帳號

1. [LINE Developers](https://developers.line.biz/)：建立 Provider → **Messaging API channel**。
2. LINE Official Account Manager → 設定 → 回應設定：關閉自動回應與加入好友歡迎訊息；**開啟「允許加入群組・多人聊天室」**。
3. Developers Console → Messaging API 分頁：發行 **Channel access token（長效）**；記下 **Channel secret**。
4. 部署後（步驟 4）回來設定 **Webhook URL** 為 `lineWebhook` 的 Functions URL，並啟用 Use webhook。

### 3. Secrets 與環境變數

```bash
# 寫入 token（自己產生一個 ≥ 22 字元的隨機字串）
openssl rand -base64 24 | tr '+/' '-_' | tr -d '='

firebase functions:secrets:set WRITE_TOKEN
firebase functions:secrets:set LINE_CHANNEL_SECRET
firebase functions:secrets:set LINE_CHANNEL_ACCESS_TOKEN
firebase functions:secrets:set TRAVELER_LINE_UID     # 先隨便填，步驟 5 再更新

cp functions/.env.example functions/.env             # 填 PUBLIC_BASE_URL
cp web/.env.example web/.env                         # 填 Firebase Web 設定與 MapTiler key
```

### 4. 部署

```bash
cd functions && npm install && npm test && cd ..
cd web && npm install && cd ..
firebase deploy
```

部署輸出會列出 `lineWebhook` 的 URL，填回 LINE Developers 的 Webhook URL。

### 5. 綁定群組與旅行者身分

1. 把官方帳號邀請進家人群組。bot 會回「已加入」，`config/line.groupId` 已寫入。
2. 自己在群組傳任一則訊息，到 Cloud Logging 找 `message from userId (set TRAVELER_LINE_UID)`，把 `userId` 寫入 Secret 並重新部署 functions：

   ```bash
   firebase functions:secrets:set TRAVELER_LINE_UID
   firebase deploy --only functions
   ```
3. 開 `https://<host>/me`，輸入 `WRITE_TOKEN`，確認「LINE 群組：已綁定」。

### 6. 捷徑

依 [`shortcuts/README.md`](shortcuts/README.md) 建立捷徑 A（必要）、B、C。

## 日常使用

1. `/me` 建立行程（群組收到「行程開始」與家人頁連結）。
2. 出門後按捷徑 A 打卡。打卡不推群組；家人看家人頁，或在群組輸入「在哪」「行程」。
3. 長途飛行前按捷徑 C 或在群組輸入 `離線 16`。
4. 逾時未打卡：群組收到警報，每 3 小時重複、最多 4 次；台北 23:00–07:00 發出的警報會在 08:00 補發一次。
5. 回家後 `/me` 結束行程，或在群組輸入 `結束`。忘了的話結束時間 24 小時後自動結案。

## 開發

```bash
cd functions && npm run typecheck && npm test   # 純函式單元測試
cd functions && npm run e2e                      # emulator 端到端（需 Java 與 firebase CLI）
cd web && npm run typecheck && npm run build
firebase emulators:start        # Functions + Firestore + Hosting（需先 build）
```

`npm run e2e` 會在離線的 demo 專案上跑完整 API 流程與逾時狀態機，首次執行會產生 `functions/.secret.local`（測試用假值，已 gitignore）。

`checkOverdue` 的決策邏輯在 `functions/src/overdue-logic.ts`，為純函式，測試在 `functions/test/`。
