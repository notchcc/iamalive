# iamalive — 個人用旅行報平安 Web App 技術規格書

| 項目 | 內容 |
|---|---|
| 文件版本 | v0.3 |
| 日期 | 2026-09-04 |
| 狀態 | 設計定稿，可進入開發 |

### 版本歷史

| 版本 | 變更 |
|---|---|
| v0.1 | LIFF + LINE 官方帳號多使用者版（已廢棄） |
| v0.2 | 個人用、純 PWA、Web Push 通知、capability token |
| v0.3 | 通知改為**官方帳號推播到家人 LINE 群組**；移除 PWA 推播層；打卡入口以 **iOS 捷徑**為主，LINE 位置訊息為輔 |

---

## 1. 概述

### 1.1 目標

1. 旅行者（即開發者本人）一鍵打卡，5 秒內完成，不需開啟任何網頁。
2. 家人**零安裝、零登入、零設定**：通知直接出現在既有的家人 LINE 群組，地圖與時間軸點連結即看。
3. 逾時未打卡時群組收到警報，持續未回報時定期重複，有次數上限。
4. 長途飛行、無訊號路段可**預告離線**，避免假警報。

### 1.2 非目標

| 項目 | 原因 |
|---|---|
| 多使用者 / 多旅行者 | 個人使用，沒有註冊流程 |
| 背景自動定位 | 網頁與捷徑皆無法持續背景執行；打卡一律由使用者主動觸發 |
| 1 對 1 LINE 推播給家人 | 需每位家人加官方帳號好友；群組推播不需要 |
| Web Push / PWA 安裝 | 已由 LINE 群組推播取代 |
| SOS / 報警串接 | 非救援工具 |

### 1.3 設計前提

- **一個 LINE 官方帳號（Messaging API channel）**，個人用免費方案，不認證、不審核。它以成員身分加入家人群組，推播以群組為單位計費。
- **所有寫入都經過 Cloud Functions**，前端不直接寫 Firestore。
- **旅行者身分用 capability token**（捷徑與管理頁），家人頁用讀取 token 直接讀 Firestore 投影文件。
- **Firebase 必須為 Blaze 方案**，實際用量在免費額度內，需設預算告警。

---

## 2. 系統架構

```
 旅行者手機                                   家人
 ┌───────────────────┐                        ┌────────────────────────┐
 │ iOS 捷徑「我平安」  │                        │ LINE 家人群組           │
 │  取得位置 → POST   │                        │  ← 官方帳號推播         │
 ├───────────────────┤                        │  · 打卡通知（位置訊息）  │
 │ LINE 群組傳位置     │──┐                     │  · 逾時警報             │
 │ （備援）            │  │ webhook             │  · 「在哪」→ reply      │
 ├───────────────────┤  │                     ├────────────────────────┤
 │ /me 管理頁（備援）  │  │                     │ 網頁 /w/{readToken}     │
 └────────┬──────────┘  │                     │  地圖 + 時間軸 (onSnapshot)│
          │ X-Write-Token│                     └──────────┬─────────────┘
          ▼             ▼                                │ get
 ┌───────────────────────────────────────────────────────┼─────────────┐
 │ Firebase                                              │             │
 │  Hosting ── 靜態 SPA、/api/** rewrite → Functions      │             │
 │  Cloud Functions (2nd gen, Node 22, asia-east1)       │             │
 │   · api            checkin / trips / watchers         │             │
 │   · lineWebhook    join / leave / location / text     │             │
 │   · checkOverdue   每 15 分鐘                          │             │
 │        │                                              │             │
 │  Firestore  trips / checkins / views / config ────────┘             │
 │  Secret Manager  WRITE_TOKEN / LINE_CHANNEL_* / TRAVELER_LINE_UID   │
 └──────────────┬──────────────────────────────────────────────────────┘
                │ Messaging API push / reply
                ▼
         LINE Platform → 家人群組
```

### 2.1 技術選型

| 層 | 選型 | 備註 |
|---|---|---|
| 前端 | Vite + TypeScript（框架任選） | 兩條路由，靜態部署 |
| 地圖 | Leaflet + MapTiler 免費層（或其他圖磚商） | 不直接用 OSM 官方圖磚 |
| 託管 | Firebase Hosting | CDN、HTTPS、自訂 header |
| 後端 | Cloud Functions for Firebase **2nd gen**，Node.js **22** | Node 20 已 EOL |
| 資料庫 | Firestore (Native)，區域 `asia-east1` | 與 Functions 同區 |
| 排程 | `onSchedule` (Cloud Scheduler) | 每 15 分鐘 |
| 通知 | LINE Messaging API（`@line/bot-sdk`） | push 到群組、reply 免費 |
| 打卡入口 | iOS 捷徑（主）、LINE 位置訊息（輔）、網頁（備援） | 見 §6 |
| 秘密 | Firebase Secret Manager (`defineSecret`) | 不放 Firestore、不進 repo |

---

## 3. 身分與憑證

| 角色 | 憑證 | 用途 | 儲存位置 |
|---|---|---|---|
| 旅行者（HTTP） | `WRITE_TOKEN`（Secret） | 建立/結束行程、打卡、預告離線、管理家人 | iOS 捷徑、`/me` 頁 localStorage |
| 旅行者（LINE） | `TRAVELER_LINE_UID`（Secret） | webhook 只接受此 userId 的位置訊息與指令 | Secret |
| 家人（網頁） | `readToken`（Firestore 文件 ID） | 讀取 `views/{readToken}` | 連結網址 |
| 家人（LINE） | 群組成員身分 | 收推播、在群組下指令 | 無需任何設定 |
| 官方帳號 | `LINE_CHANNEL_SECRET`、`LINE_CHANNEL_ACCESS_TOKEN` | 驗證 webhook、呼叫 push/reply | Secret |

- token 皆為 ≥ 128 bit 隨機值，base64url 編碼。
- 寫入 token 比對使用 `crypto.timingSafeEqual`。
- 讀取 token 可個別撤銷：刪除 `views/{readToken}` 即失效。
- `TRAVELER_LINE_UID` 於首次在群組傳訊息時從 webhook log 取得後寫入 Secret。

---

## 4. 資料模型（Firestore）

### 4.1 `config/line`（僅 Functions 讀寫）

| 欄位 | 型別 | 說明 |
|---|---|---|
| `groupId` | string \| null | 官方帳號所在的家人群組 ID，由 `join` 事件寫入，`leave` 事件清空 |
| `joinedAt` | timestamp \| null | |
| `monthKey` | string | 額度計數月份 `YYYY-MM` |
| `pushCount` | number | 本月已 push 則數（reply 不計） |

### 4.2 `trips/{tripId}`（僅 Functions 讀寫）

| 欄位 | 型別 | 說明 |
|---|---|---|
| `title` | string | 行程名稱 |
| `startAt` / `endAt` | timestamp | 行程起訖 |
| `intervalHours` | number | 預設打卡間隔（1–72） |
| `status` | string | `active` / `completed` |
| `notifyEveryCheckin` | boolean | 是否每次打卡都推群組（預設 true，額度吃緊時關） |
| `lastCheckinAt` | timestamp \| null | |
| `lastCheckinGeo` | geopoint \| null | |
| `nextDeadlineAt` | timestamp | **下一個期限**，建立時 = `max(startAt, now) + intervalHours`；每次打卡重算 |
| `offlineUntil` | timestamp \| null | 預告離線至此時間，期間不警報 |
| `alerted` | boolean | 本期限內是否已發過警報，打卡後歸零 |
| `alertCount` | number | 本期限內已發警報數，打卡後歸零 |
| `lastAlertAt` | timestamp \| null | |
| `readTokens` | array\<string\> | 家人網頁 token 清單 |
| `createdAt` / `updatedAt` | timestamp | |

### 4.3 `trips/{tripId}/checkins/{checkinId}`（僅 Functions 寫入）

| 欄位 | 型別 | 說明 |
|---|---|---|
| `geo` | geopoint | 座標 |
| `accuracy` | number \| null | 公尺；捷徑與 LINE 位置訊息為 null |
| `source` | string | `shortcut` / `line` / `web-gps` / `manual` |
| `note` | string | ≤ 200 字，可空 |
| `nextHours` | number \| null | 本次預告「下次幾小時後回報」 |
| `createdAt` | timestamp | 伺服器時間 |
| `clientAt` | timestamp \| null | 裝置時間 |

### 4.4 `views/{readToken}`（家人網頁即時讀取的投影）

| 欄位 | 型別 | 說明 |
|---|---|---|
| `tripId` | string | |
| `label` | string | 家人稱呼 |
| `title` / `status` | string | 複製自 trip |
| `lastCheckinAt` / `nextDeadlineAt` / `offlineUntil` | timestamp \| null | 複製自 trip |
| `recent` | array\<map\> | 最近 100 筆 `{lat, lng, acc, src, note, at}` |
| `updatedAt` | timestamp | |

每次打卡、預告離線、結案，Function 在同一個 batch 內更新 `trips` 與該行程所有 `views/*`。

### 4.5 索引

- `trips`：複合 `status ASC, nextDeadlineAt ASC`
- `checkins`：單欄 `createdAt DESC`（自動）

### 4.6 安全規則

```javascript
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /views/{readToken} {
      allow get: if true;          // 知道 token 即可讀單一文件
      allow list, write: if false;
    }
    match /{document=**} {
      allow read, write: if false; // 其餘只允許 Admin SDK
    }
  }
}
```

---

## 5. API

### 5.1 Function `api`（Hosting rewrite `/api/**`）

寫入端點需 header `X-Write-Token`。錯誤一律 `{ error: string }`。

| Method | Path | 用途 | 主要邏輯 |
|---|---|---|---|
| POST | `/api/checkin` | 打卡 | 見 5.2 |
| POST | `/api/trips` | 建立行程 | 寫 `trips`；若群組已綁定則推「行程開始」 |
| POST | `/api/trips/:id/end` | 結束行程 | `status = completed`，同步 views，推「行程結束」 |
| POST | `/api/trips/:id/offline` | 預告離線 | `{ hours }` → `offlineUntil`、`nextDeadlineAt = offlineUntil + interval`，推「將離線至 T」 |
| POST | `/api/trips/:id/watchers` | 新增家人網頁連結 | 產生 readToken，建立 `views/{token}`，回傳連結 |
| DELETE | `/api/trips/:id/watchers/:token` | 撤銷連結 | 刪 view |
| GET | `/api/trips/active` | 取目前 active 行程 | 捷徑與 `/me` 用 |
| GET | `/api/status` | 群組綁定狀態、本月已用額度 | `/me` 顯示 |

### 5.2 `POST /api/checkin`

```
Request:  { lat, lng, accuracy?, source, note?, nextHours?, clientAt? }
Response: { ok: true, nextDeadlineAt, pushed: boolean }
```

1. 驗證 token、座標範圍、`note.length ≤ 200`、`nextHours ∈ [1, 168]`。
2. 找 `status == active` 的行程（無則 409）。
3. batch：新增 checkin；更新 trip（`lastCheckinAt`、`lastCheckinGeo`、`nextDeadlineAt = now + (nextHours ?? intervalHours)`、`offlineUntil = null`、`alerted = false`、`alertCount = 0`）；更新所有 views。
4. 推播群組（受 `notifyEveryCheckin` 與額度守門控制，見 §9）：
   - 若打卡前 `alerted == true`：一律推「已恢復回報」。
   - 否則依設定推位置訊息 + 一行文字（時間、備註、下次期限）。

### 5.3 Function `lineWebhook`（`POST /line/webhook`，獨立 URL）

- 驗證 `x-line-signature`（HMAC-SHA256，Channel Secret），失敗回 401。
- 一律先回 200，再非同步處理事件（LINE 要求 1 秒內回應）。

| 事件 | 處理 |
|---|---|
| `join`（被拉進群組） | 寫 `config/line.groupId`，reply「已加入，之後會在這裡報平安」 |
| `leave` | 清空 `groupId`；`/me` 顯示未綁定 |
| `message.location` 且 `source.userId == TRAVELER_LINE_UID` | 視為打卡，`source = line`，`note = title/address`（LINE 位置訊息附帶）；依 §5.2 流程，但**不再推位置訊息**（群組已看到），只 reply 一行「已記錄，下次期限 HH:mm」 |
| `message.text` 且來自旅行者 | 指令：`離線 16` → 預告離線 16 小時；`結束` → 結案；`備註 xxx` → 補到最後一筆打卡 |
| `message.text` 且來自任何成員，內容含 `在哪` / `平安` | reply 最後位置訊息 + 距今時間 + 網頁連結（reply 免費，不計額度） |
| 其他 | 忽略 |

- 只處理 `source.type == 'group'` 且 `groupId` 相符的事件，避免被拉進其他群組時誤動作。
- 非旅行者傳的位置訊息忽略。

---

## 6. 旅行者打卡入口

### 6.1 iOS 捷徑（主要路徑）

#### 6.1.1 評估結論

可行且為最佳主入口：不經網頁、無登入、無冷啟動等待，整段「取得位置 → POST → 顯示結果」通常 2–5 秒。

| 面向 | 狀況 | 對策 |
|---|---|---|
| 觸發方式 | 動作按鈕、控制中心（iOS 18）、背面輕點、Siri 語音可在不開啟捷徑 App 下執行；主畫面圖示會短暫跳 App | 主要用動作按鈕或控制中心 |
| 定位精度值 | 捷徑位置物件無穩定的水平精度欄位 | `accuracy = null`，家人頁不畫精度圈，標「來源：捷徑」；頁面說明室內可能偏差 |
| 定位逾時 | 「取得目前位置」無法設逾時，室內或山谷可能久等 | 精確度選「最佳」；卡住時手動取消改用 LINE 位置或網頁選點 |
| 錯誤處理 | 捷徑無 try/catch，POST 失敗只有系統錯誤橫幅；無離線排隊 | 接受；稍後重按。計畫中的無訊號段用預告離線 |
| 無網路 | GPS 可定位但 POST 失敗 | 同上 |
| token 安全 | 寫入 token 明文存在捷徑內 | 不以 iCloud 連結分享此捷徑；外流時換 Secret 重新部署 |
| 自動化 | 定時自動化可自動執行捷徑 | **只用於提醒，禁止用於自動送出位置**，否則「沒打卡」失去意義 |

#### 6.1.2 捷徑定義

**捷徑 A：「我平安」（零互動）**

```
1. 取得目前位置             （精確度：最佳）
2. 取得 URL 內容
     URL      https://<hosting>/api/checkin
     方法      POST
     標頭      X-Write-Token: <token>
     請求本文  JSON
       lat       = 位置.緯度
       lng       = 位置.經度
       source    = "shortcut"
       clientAt  = 目前日期（ISO 8601）
3. 從 字典 取得 nextDeadlineAt
4. 顯示通知 「已打卡，下次期限：{nextDeadlineAt 格式化}」
```

**捷徑 B：「我平安＋預告」**

```
1. 取得目前位置
2. 從選單選擇「下次回報」
     預設 → nextHours 不帶
     6 小時 / 12 小時 / 24 小時 / 飛行 16 小時 → 對應數字
     自訂 → 要求輸入（數字）
3. 要求輸入「備註（可空）」      ← 以 Siri 執行時可口述
4. 取得 URL 內容（同 A，多帶 nextHours、note）
5. 顯示通知
```

**捷徑 C：「預告離線」**（不定位，只 POST `/api/trips/:id/offline`）

**自動化（提醒用）**：每日固定時間「顯示通知：該報平安了」，或於期限前由 `/api/trips/active` 取 `nextDeadlineAt` 後動態顯示。不送出位置。

### 6.2 LINE 群組位置訊息（輔助路徑）

- 在家人群組按「＋ → 位置資訊 → 傳送」，約 3 次點擊、5–8 秒。
- webhook 收到後視為打卡（§5.3）。
- 優點：任何手機皆可、家人在聊天室直接看到位置、不需捷徑。
- 缺點：需開 LINE、點擊較多、同樣沒有精度值。

### 6.3 `/me` 網頁（備援與管理）

- 首次輸入寫入 token，存 localStorage。
- 「用瀏覽器定位打卡」：`getCurrentPosition({ enableHighAccuracy: true, timeout: 10000, maximumAge: 60000 })`，`source = web-gps`，此路徑有精度值。
- 「地圖選點打卡」：定位失敗時的手動路徑，`source = manual`。
- 建立 / 結束行程、預告離線、切換 `notifyEveryCheckin`、新增 / 撤銷家人連結、顯示群組綁定狀態與本月額度。

---

## 7. 逾時偵測（`checkOverdue`，每 15 分鐘）

```javascript
export const checkOverdue = onSchedule(
  { schedule: 'every 15 minutes', region: 'asia-east1', secrets: [...] },
  async () => {
    const now = Timestamp.now();
    const snap = await db.collection('trips')
      .where('status', '==', 'active')
      .where('nextDeadlineAt', '<=', now)
      .get();

    for (const doc of snap.docs) {
      const t = doc.data();

      if (t.endAt.toMillis() + 24 * 3600e3 < now.toMillis()) {
        await completeTrip(doc, '行程已結束（自動結案）');
        continue;
      }
      if (t.offlineUntil && t.offlineUntil > now) continue;

      const overdueH = (now.toMillis() - t.nextDeadlineAt.toMillis()) / 3600e3;
      const sinceLast = t.lastAlertAt
        ? (now.toMillis() - t.lastAlertAt.toMillis()) / 3600e3 : Infinity;

      if (!t.alerted) {
        await pushGroup(alertMessage(t, overdueH), { priority: 'alert' });
        await doc.ref.update({ alerted: true, alertCount: 1, lastAlertAt: now });
      } else if (sinceLast >= REPEAT_H /* 3 */ && t.alertCount < MAX_ALERTS /* 4 */) {
        await pushGroup(alertMessage(t, overdueH), { priority: 'alert' });
        await doc.ref.update({ alertCount: t.alertCount + 1, lastAlertAt: now });
      }
      // 達上限後停止，直到下一次打卡把 alerted 歸零
    }
  });
```

| 參數 | 預設 | 說明 |
|---|---|---|
| 掃描頻率 | 15 分鐘 | 實際延遲 ≤ 15 分鐘 |
| `REPEAT_H` | 3 | 重複警報間隔 |
| `MAX_ALERTS` | 4 | 單一期限內警報總數上限 |
| 自動結案 | `endAt + 24h` | 避免忘記結案後永久警報 |

警報訊息內容：「⚠️ {title}：已超過預定回報時間 X 小時未回報。最後回報 T（Y 小時前）」+ 位置訊息（最後位置）+ 網頁連結。文案只說「尚未回報」，不說「出事」。

---

## 8. 家人網頁（`/w/{readToken}`）

- 純網頁，從 LINE 內建瀏覽器開啟即可，不需安裝、不需通知權限。
- 頂部大字「最後回報：X 小時前」；逾時變色；離線預告時顯示「預告離線至 T」。
- 地圖：所有打卡點，最後一點高亮；有精度值者畫精度圈；`shortcut` / `line` 來源標示「精度未知」；`manual` 以不同圖示標示。
- 時間軸：時間、備註、距今多久、來源。
- 資料來源：`onSnapshot(doc('views', token))`，即時更新。
- Hosting header：`Referrer-Policy: same-origin`（token 不隨 Referer 送給圖磚商）、`Cache-Control: no-store`。
- 頁面不放任何 `og:` 位置資訊；GET 無副作用（LINE 連結預覽爬蟲會抓）。

---

## 9. LINE 通知

### 9.1 訊息類型

| 事件 | 訊息 | 計額度 |
|---|---|---|
| 打卡 | 位置訊息（地圖縮圖）+ 文字「HH:mm 已報平安 · 備註 · 下次期限」 | push，1 則 |
| 打卡（由 LINE 位置訊息觸發） | reply「已記錄，下次期限 HH:mm」 | reply，免費 |
| 恢復回報 | 文字 + 位置 | push，1 則 |
| 預告離線 | 文字「將離線至 T，期間不會警報」 | push，1 則 |
| 逾時警報 | 文字 + 位置 + 連結 | push，1 則 |
| 行程開始 / 結束 | 文字 + 網頁連結 | push，1 則 |
| 家人問「在哪」 | reply 最後位置 + 距今 + 連結 | reply，免費 |

- 群組為單一收件對象：**一次 push 不論群組人數只計 1 則**（一次 push 內最多 5 個訊息物件仍算 1 則）。
- 使用 `@line/bot-sdk` 的 `pushMessage` / `replyMessage`；失敗（bot 已離開群組等）記 log 並在 `/me` 顯示。

### 9.2 額度守門

免費方案每月 200 則（以 LINE 官方最新方案為準）。`pushGroup` 前檢查 `config/line.pushCount`：

| 已用 | 行為 |
|---|---|
| < 150 | 全部推 |
| 150–190 | 停止每次打卡通知（等同 `notifyEveryCheckin = false`），保留警報、恢復、離線、起訖 |
| ≥ 190 | 只推逾時警報與恢復回報 |
| ≥ 200 | 不推；`/me` 顯示告警。家人仍可在群組問「在哪」（reply 免費） |

估算：一趟 14 天、每 12 小時打卡 ≈ 28 則打卡通知 + 起訖 2 則 + 少量警報 ≈ 35 則。每月可容納約 4–5 趟。

### 9.3 官方帳號設定（一次性）

1. LINE Developers：建立 Provider → Messaging API channel（或在 LINE Official Account Manager 建 OA 後啟用 Messaging API）。
2. OA Manager → 設定 → 回應設定：關閉自動回應、關閉加入好友歡迎訊息；**開啟「允許加入群組・多人聊天室」**。
3. Developers Console → Messaging API：設定 Webhook URL 為 `lineWebhook` 的 URL，啟用 Use webhook；發行長效 Channel access token。
4. 把 OA 邀請進家人群組 → webhook 收到 `join` → `groupId` 寫入 `config/line`。
5. 在群組傳一則訊息 → 從 log 取得自己的 `userId` → 寫入 Secret `TRAVELER_LINE_UID`。

---

## 10. 部署設定

### 10.1 `firebase.json`

```json
{
  "hosting": {
    "public": "web/dist",
    "rewrites": [
      { "source": "/api/**", "function": { "functionId": "api", "region": "asia-east1" } },
      { "source": "**", "destination": "/index.html" }
    ],
    "headers": [
      { "source": "/w/**", "headers": [
        { "key": "Referrer-Policy", "value": "same-origin" },
        { "key": "Cache-Control", "value": "no-store" }
      ]}
    ]
  },
  "functions": { "source": "functions", "runtime": "nodejs22" },
  "firestore": { "rules": "firestore.rules", "indexes": "firestore.indexes.json" }
}
```

`lineWebhook` 不經 Hosting rewrite，直接用 Functions 的 URL，避免 rewrite 改寫 raw body 影響簽章驗證。

### 10.2 Secrets

```
firebase functions:secrets:set WRITE_TOKEN
firebase functions:secrets:set LINE_CHANNEL_SECRET
firebase functions:secrets:set LINE_CHANNEL_ACCESS_TOKEN
firebase functions:secrets:set TRAVELER_LINE_UID
```

### 10.3 Functions 設定

- 2nd gen、`region: 'asia-east1'`、`minInstances: 0`、`maxInstances: 3`、`timeoutSeconds: 60`。
- `lineWebhook` 需 raw body：使用 `onRequest` 並以 `req.rawBody` 驗簽。
- 專案目錄：`web/`、`functions/`、`firestore.rules`、`firestore.indexes.json`、`shortcuts/`（捷徑說明與截圖）。

---

## 11. 成本（Blaze，個人用量）

| 項目 | 估算 | 費用 |
|---|---|---|
| Firestore | 每月數千次讀寫 | 免費額度內 |
| Functions | 排程 2,880 次/月 + webhook + 打卡 | 免費額度內 |
| Hosting | < 1 GB | 免費額度內 |
| Cloud Scheduler | 1 個 job | 免費 |
| Secret Manager | 4 個 secret | 免費額度內 |
| LINE 官方帳號 | 輕用量方案 | 免費（200 則/月） |
| 地圖圖磚 | MapTiler 免費層 | 0 |

超過 200 則需升級付費方案（台灣中用量方案約每月 NT$800 起，以官方為準）。設定 GCP 預算告警。

---

## 12. 風險與對策

| 風險 | 對策 |
|---|---|
| bot 被移出群組 | `leave` 事件清空 groupId；`/me` 顯示紅字；捷徑回應帶 `pushed: false` |
| 訊息額度用盡 | §9.2 分級降載；家人用「在哪」reply 免費查詢 |
| 夜間 LINE 通知被靜音 | LINE 通常已在家人專注模式允許清單；仍為已接受限制 |
| 飛行 / 無訊號造成假警報 | `nextHours` 預告；`離線 N` 指令；捷徑 C |
| 忘記結案 | `endAt + 24h` 自動結案 |
| 捷徑內寫入 token 外流 | 不分享捷徑；換 Secret 重新部署 |
| 捷徑無精度值 | 家人頁標示「精度未知」與室內偏差說明 |
| 網頁 token 外流 | 可個別撤銷；`Referrer-Policy`；無副作用 GET |
| bot 被拉進別的群組 | webhook 只處理已綁定 groupId；其他群組事件忽略且不 reply |
| 排程重複觸發 | `alerted` / `lastAlertAt` 狀態機冪等 |
| 他人在群組傳位置 | webhook 比對 `TRAVELER_LINE_UID`，忽略他人 |

---

## 13. 開發順序（估 3–4 個工作天）

| 步驟 | 內容 | 工時 |
|---|---|---|
| 1 | Firebase 專案、Blaze、Secrets、規則與索引；LINE OA 與 channel 設定（§9.3） | 0.5 天 |
| 2 | `api` Function：trips / checkin / offline / watchers / status | 1 天 |
| 3 | `lineWebhook`：驗簽、join/leave、位置訊息打卡、文字指令、「在哪」reply；`pushGroup` 與額度守門 | 1 天 |
| 4 | 家人網頁：onSnapshot、地圖、時間軸 | 0.5 天 |
| 5 | `/me` 管理頁 + 捷徑 A/B/C 製作與說明文件 | 0.5 天 |
| 6 | `checkOverdue` 狀態機 + 實機測試 | 0.5 天 |

### 13.1 驗證清單

- [ ] 捷徑 A 從動作按鈕執行，5 秒內群組收到位置訊息，家人網頁同步更新
- [ ] 捷徑 B 帶 `nextHours = 16`，群組訊息顯示正確下次期限
- [ ] 在群組傳 LINE 位置訊息，收到 reply「已記錄」且不重複推位置
- [ ] 家人在群組打「在哪」，bot reply 最後位置，`pushCount` 不增加
- [ ] 他人在群組傳位置，無任何反應
- [ ] 手動把 `nextDeadlineAt` 改成過去，15 分鐘內群組收到警報
- [ ] `REPEAT_H` 後收到重複警報，達 `MAX_ALERTS` 後停止
- [ ] 打卡後 `alerted` 歸零並收到「已恢復回報」
- [ ] `離線 16` 指令生效，期間排程不警報
- [ ] 把 bot 移出群組，`/me` 顯示未綁定；重新邀請後自動恢復
- [ ] `pushCount` 手動設為 195，打卡通知被抑制、警報仍送
- [ ] 撤銷家人 token 後其頁面顯示連結已失效

---

## 14. 待決事項

| # | 項目 |
|---|---|
| 1 | `REPEAT_H` 與 `MAX_ALERTS` 的實際值 |
| 2 | 每次打卡是否都推群組（`notifyEveryCheckin` 預設值），或只推早晚各一次 |
| 3 | 打卡通知用位置訊息 + 文字（2 個物件、1 則）或 Flex Message（1 個物件，可含地圖圖片與按鈕） |
| 4 | 是否保留家人網頁，或只靠群組內「在哪」查詢（若拿掉可再省一天工時） |
