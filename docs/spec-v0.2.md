# iamalive — 個人用旅行報平安 Web App 技術規格書

| 項目 | 內容 |
|---|---|
| 文件版本 | v0.2 |
| 日期 | 2026-09-04 |
| 狀態 | 設計定稿，可進入開發 |
| 前身 | v0.1（LIFF + LINE 官方帳號版），已廢棄 |

> v0.2 與 v0.1 的差異：**個人使用、單一旅行者、家人為固定少數人；不使用 LIFF、不使用 LINE 官方帳號 / Messaging API；純 PWA 部署於 Firebase。** 因此 v0.1 的 LINE Login 認證、Firestore 多角色規則、邀請碼、限流、法遵章節全數移除。

---

## 1. 概述

### 1.1 目標

1. 旅行者（即開發者本人）一鍵打卡，兩秒內完成，不依賴任何 App 內瀏覽器。
2. 家人點一條連結即可看到地圖與時間軸，**看**的動作零安裝、零登入。
3. 逾時未打卡時，家人收到通知；持續未回報時升級為語音來電。
4. 長途飛行、無訊號路段可**預告離線**，避免假警報。

### 1.2 非目標

| 項目 | 原因 |
|---|---|
| 多使用者 / 多旅行者 | 個人使用，沒有註冊流程 |
| 背景自動定位 | 網頁無法背景執行；改由 iOS 捷徑一鍵送出 |
| LINE 內推播 | 無官方帳號即無 Messaging API；LINE Notify 已於 2025 年停服 |
| SOS / 報警串接 | 非救援工具 |

### 1.3 設計前提

- **所有寫入都經過 Cloud Functions**，前端不直接寫 Firestore。
- **身分用 capability token**，不用 Firebase Auth：一把寫入 token（旅行者），每位家人一把讀取 token。
- **家人頁用 Firestore 即時讀取**：以讀取 token 作為文件 ID，規則只開放 `get`、禁止 `list`，token 本身就是授權。
- **Firebase 必須為 Blaze 方案**（Cloud Functions 需要），實際用量在免費額度內，需設預算告警。

---

## 2. 系統架構

```
 旅行者手機                          家人手機
 ┌──────────────┐                    ┌─────────────────────────┐
 │ iOS 捷徑      │                    │ PWA（加到主畫面）         │
 │ 取得位置→POST │                    │ /w/{readToken}          │
 └──────┬───────┘                    │  · onSnapshot 即時讀     │
        │                            │  · Web Push 訂閱         │
 ┌──────┴───────┐                    └───────┬─────────┬───────┘
 │ /me 管理頁    │                            │ get     │ POST subscribe
 │ (備援打卡、   │                            │         │
 │  建立/結束、  │                            │         │
 │  預告離線)    │                            │         │
 └──────┬───────┘                            │         │
        │ POST (X-Write-Token)               │         │
        ▼                                    │         ▼
 ┌────────────────────────────────────────────┼──────────────────┐
 │ Firebase                                   │                  │
 │  Hosting ── 靜態 SPA、/api/** rewrite → Functions             │
 │                                            │                  │
 │  Cloud Functions (2nd gen, Node 22, asia-east1)               │
 │   · api            HTTP：checkin / trips / subscribe / twiml  │
 │   · checkOverdue   Scheduler：每 15 分鐘                       │
 │        │                                   │                  │
 │        ▼                                   │                  │
 │  Firestore ────────────────────────────────┘                  │
 │   trips / trips/{id}/checkins / views/{readToken} / subs      │
 │                                                               │
 │  Secret Manager：WRITE_TOKEN、VAPID、TWILIO                    │
 └───────────┬───────────────────────────┬───────────────────────┘
             │ Web Push (VAPID)          │ Twilio Voice REST
             ▼                           ▼
      Apple / Google 推播中繼          Twilio → 家人電話
```

### 2.1 技術選型

| 層 | 選型 | 備註 |
|---|---|---|
| 前端 | Vite + TypeScript（框架任選，React 或 vanilla） | 兩條路由，靜態部署 |
| 地圖 | Leaflet + MapTiler 免費層（或其他圖磚商） | 不直接用 OSM 官方圖磚 |
| 託管 | Firebase Hosting | CDN、HTTPS、自訂 header |
| 後端 | Cloud Functions for Firebase **2nd gen**，Node.js **22** | Node 20 已 EOL |
| 資料庫 | Firestore (Native)，區域 `asia-east1` | 與 Functions 同區 |
| 排程 | `onSchedule` (Cloud Scheduler) | 每 15 分鐘 |
| 推播 | `web-push` npm（VAPID） | Node 環境可直接用 |
| 語音 | Twilio Programmable Voice | 逾時升級用 |
| 秘密 | Firebase Secret Manager (`defineSecret`) | 不放 Firestore、不進 repo |

---

## 3. 角色與 token

| 角色 | 憑證 | 用途 | 儲存位置 |
|---|---|---|---|
| 旅行者 | `WRITE_TOKEN`（單一，Secret） | 建立/結束行程、打卡、預告離線、管理家人 | iOS 捷徑、`/me` 頁 localStorage |
| 家人 | `readToken`（每人一把，Firestore 文件 ID） | 讀取 `views/{readToken}`、訂閱推播 | 連結網址、PWA IndexedDB |

- token 皆為 ≥ 128 bit 隨機值，base64url 編碼（22 字元）。
- 寫入 token 比對使用 `crypto.timingSafeEqual`。
- 讀取 token 可個別撤銷：刪除 `views/{readToken}` 文件即失效，相關訂閱一併刪除。
- 換寫入 token 時：更新 Secret、重新部署、更新捷徑。

---

## 4. 資料模型（Firestore）

### 4.1 `trips/{tripId}`（僅 Functions 讀寫）

| 欄位 | 型別 | 說明 |
|---|---|---|
| `title` | string | 行程名稱 |
| `startAt` / `endAt` | timestamp | 行程起訖 |
| `intervalHours` | number | 預設打卡間隔（1–72） |
| `status` | string | `active` / `completed` |
| `lastCheckinAt` | timestamp \| null | 最後打卡時間 |
| `lastCheckinGeo` | geopoint \| null | 最後位置 |
| `nextDeadlineAt` | timestamp | **下一個期限**，建立時 = `startAt + intervalHours`；每次打卡重算 |
| `offlineUntil` | timestamp \| null | 預告離線至此時間，期間不警報 |
| `alertLevel` | number | 目前警報等級 0/1/2，打卡後歸零 |
| `alertCount` | number | 本期限內已發警報數，打卡後歸零 |
| `lastAlertAt` | timestamp \| null | 上次警報時間 |
| `readTokens` | array\<string\> | 此行程的家人 token 清單（方便反查） |
| `createdAt` / `updatedAt` | timestamp | |

### 4.2 `trips/{tripId}/checkins/{checkinId}`（僅 Functions 寫入）

| 欄位 | 型別 | 說明 |
|---|---|---|
| `geo` | geopoint | 座標 |
| `accuracy` | number | 公尺 |
| `source` | string | `shortcut` / `web-gps` / `manual` |
| `note` | string | ≤ 200 字，可空 |
| `nextHours` | number \| null | 本次預告「下次幾小時後回報」，null 則用行程預設 |
| `createdAt` | timestamp | 伺服器時間 |
| `clientAt` | timestamp \| null | 裝置時間 |

### 4.3 `views/{readToken}`（家人頁即時讀取的投影）

| 欄位 | 型別 | 說明 |
|---|---|---|
| `tripId` | string | 對應行程 |
| `label` | string | 家人稱呼（如「媽媽」） |
| `title` | string | 行程名稱（複製） |
| `status` | string | 行程狀態（複製） |
| `lastCheckinAt` | timestamp \| null | 複製 |
| `nextDeadlineAt` | timestamp | 複製 |
| `offlineUntil` | timestamp \| null | 複製 |
| `recent` | array\<map\> | 最近 100 筆打卡 `{lat, lng, acc, src, note, at}` |
| `updatedAt` | timestamp | |

每次打卡、預告離線、結案，Function 在同一個 batch 內更新 `trips` 與該行程所有 `views/*`，家人頁透過 `onSnapshot` 即時更新，不需輪詢、不需 Function 讀取路徑。

### 4.4 `subs/{subId}`（僅 Functions 讀寫）

| 欄位 | 型別 | 說明 |
|---|---|---|
| `tripId` | string | |
| `readToken` | string | 屬於哪位家人 |
| `endpoint` | string | Push endpoint |
| `keys` | map | `{ p256dh, auth }` |
| `ua` | string | 裝置識別，除錯用 |
| `createdAt` / `lastOkAt` | timestamp | |
| `failures` | number | 連續失敗次數，404/410 直接刪除 |

### 4.5 索引

- `trips`：複合 `status ASC, nextDeadlineAt ASC`（排程掃描）
- `subs`：單欄 `tripId`（自動）
- `checkins`：單欄 `createdAt DESC`（自動）

### 4.6 安全規則

```javascript
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    // 家人頁：知道 token 即可讀單一文件；禁止列舉、禁止寫入
    match /views/{readToken} {
      allow get: if true;
      allow list, write: if false;
    }
    // 其餘全部只允許 Admin SDK
    match /{document=**} {
      allow read, write: if false;
    }
  }
}
```

---

## 5. API（Cloud Function `api`，Hosting rewrite `/api/**`）

所有寫入端點需 header `X-Write-Token`。錯誤一律 `{ error: string }`。

| Method | Path | 用途 | 主要邏輯 |
|---|---|---|---|
| POST | `/api/checkin` | 打卡 | 見 5.1 |
| POST | `/api/trips` | 建立行程 | 寫 `trips`，`nextDeadlineAt = startAt + interval`；若 `startAt` 已過則 = `now + interval` |
| POST | `/api/trips/:id/end` | 結束行程 | `status = completed`，同步 views，刪除該行程 subs |
| POST | `/api/trips/:id/offline` | 預告離線 | `{ hours }` → `offlineUntil = now + hours`、`nextDeadlineAt = offlineUntil + interval`，推播家人「將離線至 T」 |
| POST | `/api/trips/:id/watchers` | 新增家人 | `{ label }` → 產生 readToken，建立 `views/{token}`，回傳連結 |
| DELETE | `/api/trips/:id/watchers/:token` | 撤銷家人 | 刪 view 與 subs |
| GET | `/api/trips/active` | 取目前 active 行程 | 捷徑與 `/me` 用 |
| POST | `/api/w/:token/subscribe` | 家人訂閱推播 | 驗證 view 存在，upsert `subs`（以 endpoint 去重）。**不需寫入 token** |
| GET | `/api/w/:token/manifest.webmanifest` | 動態 manifest | `start_url = /w/{token}`，見 §8 |
| GET | `/api/w/:token/vapid` | 回傳 VAPID public key | |
| POST | `/api/twiml/:tripId` | Twilio 來電語音內容 | 回傳 TwiML `<Say language="zh-TW">` |

### 5.1 `POST /api/checkin`

```
Request:  { lat, lng, accuracy, source, note?, nextHours?, clientAt? }
Response: { ok: true, nextDeadlineAt }
```

1. 驗證 token、座標範圍、`note.length ≤ 200`、`nextHours ∈ [1, 168]`。
2. 找 `status == active` 的行程（無則 409）。
3. 在一個 batch 內：
   - 新增 `checkins` 文件；
   - 更新 `trips`：`lastCheckinAt`、`lastCheckinGeo`、`nextDeadlineAt = now + (nextHours ?? intervalHours)`、`offlineUntil = null`、`alertLevel = 0`、`alertCount = 0`；
   - 更新該行程所有 `views/*` 的投影欄位與 `recent`（前插、截 100）。
4. 若打卡前 `alertLevel > 0`（家人已被警報過），推播家人「已恢復回報」。

---

## 6. 旅行者打卡入口

### 6.1 iOS 捷徑（主要路徑）

```
1. 取得目前位置（精確度：最佳、逾時 10 秒）
2. 從選單選擇「下次回報」： 預設 / 6 小時 / 12 小時 / 24 小時 / 飛行中 16 小時 / 自訂
3. （選用）要求輸入：備註
4. 取得 URL 內容
     POST https://<hosting>/api/checkin
     Headers: X-Write-Token: ****, Content-Type: application/json
     Body: { lat, lng, accuracy, source: "shortcut", note, nextHours, clientAt }
5. 顯示結果：「已打卡，下次期限 HH:mm」
```

- 放在主畫面、鎖定畫面小工具或動作按鈕。
- 定時提醒（v0.1 的 FR-42）由**捷徑自動化**或 iOS 提醒事項處理，不走伺服器。
- Android 以 Tasker / MacroDroid 做同樣的 HTTP POST。

### 6.2 `/me` 網頁（備援）

- 首次輸入寫入 token，存 localStorage。
- 「用瀏覽器定位打卡」：`getCurrentPosition({ enableHighAccuracy: true, timeout: 10000, maximumAge: 60000 })`。
- 「地圖選點打卡」：定位失敗時的手動路徑，`source = manual`。
- 建立 / 結束行程、預告離線、新增 / 撤銷家人並顯示可複製的連結。

---

## 7. 逾時偵測與升級（`checkOverdue`，每 15 分鐘）

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

      // 行程已過期：自動結案並通知
      if (t.endAt.toMillis() + 24 * 3600e3 < now.toMillis()) {
        await completeTrip(doc, '行程已結束（自動結案）');
        continue;
      }
      // 預告離線期間不警報
      if (t.offlineUntil && t.offlineUntil > now) continue;

      const overdueH = (now.toMillis() - t.nextDeadlineAt.toMillis()) / 3600e3;
      const sinceLast = t.lastAlertAt
        ? (now.toMillis() - t.lastAlertAt.toMillis()) / 3600e3 : Infinity;

      if (t.alertLevel === 0) {
        await pushWatchers(doc, `尚未回報：已超過期限 ${fmt(overdueH)}`);
        await doc.ref.update({ alertLevel: 1, alertCount: 1, lastAlertAt: now });
      } else if (t.alertLevel === 1 && overdueH >= ESCALATE_AFTER_H /* 3 */) {
        await pushWatchers(doc, `仍未回報：已超過 ${fmt(overdueH)}，即將致電`);
        await callWatchers(doc);                       // Twilio
        await doc.ref.update({ alertLevel: 2, alertCount: 2, lastAlertAt: now });
      } else if (t.alertLevel === 2 && sinceLast >= REPEAT_H /* 6 */ && t.alertCount < MAX_ALERTS /* 4 */) {
        await pushWatchers(doc, `仍未回報：已超過 ${fmt(overdueH)}`);
        await doc.ref.update({ alertCount: t.alertCount + 1, lastAlertAt: now });
      }
      // 達上限後停止，直到下一次打卡把 alertLevel 歸零
    }
  });
```

| 參數 | 預設 | 說明 |
|---|---|---|
| 掃描頻率 | 15 分鐘 | 實際延遲 ≤ 15 分鐘 |
| `ESCALATE_AFTER_H` | 3 | 逾時多久後升級語音來電 |
| `REPEAT_H` | 6 | 升級後重複推播間隔 |
| `MAX_ALERTS` | 4 | 單一期限內警報總數上限 |
| 自動結案 | `endAt + 24h` | 避免忘記結案後永久警報 |

文案原則：只說「尚未回報」，不說「出事」；訊息內附最後位置與時間、地圖連結、打開 App 按鈕。

---

## 8. 家人端 PWA（`/w/{readToken}`）

### 8.1 畫面

- 頂部大字：**「最後回報：X 小時前」**，逾時時變色並顯示「已超過期限 Y 小時」；離線預告時顯示「預告離線至 T」。
- 地圖：所有打卡點與精度圈，最後一點高亮；精度 > 500 m 標註「位置概略」；`manual` 來源以不同圖示標示。
- 時間軸：時間、備註、距今多久、來源。
- 底部卡片：依環境顯示安裝 / 通知引導（8.2）。

### 8.2 環境偵測與引導

| 偵測 | 條件 | 顯示 |
|---|---|---|
| LINE 內建瀏覽器 | UA 含 `Line/` | 「請點右上角 ⋯ → 用 Safari / Chrome 開啟」 |
| 一般瀏覽器分頁 | 非 standalone | iOS：「分享 → 加入主畫面」圖解；Android：`beforeinstallprompt` 安裝按鈕 |
| 已安裝 | `display-mode: standalone` 或 `navigator.standalone` | 「開啟通知」按鈕（僅在使用者點擊時呼叫 `requestPermission`） |
| 已訂閱 | `pushManager.getSubscription()` 非空 | 顯示「通知已開啟」，並每次開啟時重送訂閱刷新 `lastOkAt` |

### 8.3 PWA 技術要點

- **manifest 動態產生**，`<link rel="manifest" href="/api/w/{token}/manifest.webmanifest">`，內容：`start_url: "/w/{token}"`、`display: "standalone"`、`scope: "/w/{token}"`、icons。確保加到主畫面後開啟不掉 token。
- 首次在 standalone 內開啟時把 token 存進 IndexedDB 當備援；Safari 分頁與主畫面 App 的儲存空間不共用。
- Service Worker：處理 `push`（必呼叫 `showNotification`）、`notificationclick`（`clients.openWindow('/w/{token}')`）、`pushsubscriptionchange`（重新訂閱並上傳）。
- iOS 18.4+ 優先使用 **Declarative Web Push**（payload 為 JSON `{ web_push: 8030, notification: {...} }`），舊裝置回退傳統 push 事件。
- Hosting header：`Referrer-Policy: same-origin`（避免 token 隨 Referer 送給圖磚商）、`Cache-Control: no-store` 於 `/w/*` HTML。
- `/w/*` 頁面不放任何 `og:` 位置資訊；GET 無副作用（LINE 連結預覽爬蟲會抓）。

### 8.4 iOS 已知限制（接受）

- 僅加到主畫面後可推播（iOS 16.4+），LINE 內建瀏覽器無法安裝。
- 無自訂鈴聲、無重要警示；睡眠專注模式會靜音推播，故 Level 2 用語音來電，並請家人將 Twilio 號碼加入「最愛」以穿透勿擾。
- 刪除主畫面圖示即失去訂閱，後端收到 404/410 時刪除 `subs`。

---

## 9. 通知管道

| 等級 | 管道 | 觸發 |
|---|---|---|
| 0 | 頁面即時更新 | 每次打卡（onSnapshot） |
| 資訊 | Web Push | 預告離線、恢復回報、行程結案 |
| 1 | Web Push | 逾時 |
| 2 | Web Push + Twilio 語音 | 逾時超過 `ESCALATE_AFTER_H` |

- Web Push：`web-push` 套件，VAPID 金鑰以 Secret 儲存；每個 `subs` 逐一發送，失敗記 `failures`，404/410 刪除。
- Twilio：`POST /2010-04-01/Accounts/{sid}/Calls.json`，`Url` 指向 `/api/twiml/:tripId`，TwiML 內容為中文語音「XXX 已超過 N 小時未回報，最後位置在 …」。家人電話號碼以 Secret（`WATCHER_PHONES`，JSON）儲存，不放 Firestore。
- 需確認 Twilio 對台灣號碼的撥打與來電顯示要求。

---

## 10. 部署設定

### 10.1 `firebase.json` 重點

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
      ]},
      { "source": "/sw.js", "headers": [
        { "key": "Cache-Control", "value": "no-cache" }
      ]}
    ]
  },
  "functions": { "source": "functions", "runtime": "nodejs22" },
  "firestore": { "rules": "firestore.rules", "indexes": "firestore.indexes.json" }
}
```

### 10.2 Secrets

```
firebase functions:secrets:set WRITE_TOKEN
firebase functions:secrets:set VAPID_PUBLIC_KEY
firebase functions:secrets:set VAPID_PRIVATE_KEY
firebase functions:secrets:set TWILIO_ACCOUNT_SID
firebase functions:secrets:set TWILIO_AUTH_TOKEN
firebase functions:secrets:set TWILIO_FROM
firebase functions:secrets:set WATCHER_PHONES      # JSON: {"媽媽":"+8869..."}
```

### 10.3 Functions 設定

- 2nd gen、`region: 'asia-east1'`、`minInstances: 0`、`maxInstances: 3`、`timeoutSeconds: 60`。
- 捷徑打卡可接受 1–2 秒冷啟動，不需 min instance。
- 專案目錄：`web/`（前端）、`functions/`（後端）、`firestore.rules`、`firestore.indexes.json`。

---

## 11. 成本（Blaze，個人用量）

| 項目 | 估算 | 費用 |
|---|---|---|
| Firestore | 每月數千次讀寫 | 免費額度內 |
| Functions | 排程 2,880 次/月 + 打卡數十次 | 免費額度內 |
| Hosting | < 1 GB | 免費額度內 |
| Cloud Scheduler | 1 個 job | 免費（3 個內） |
| Secret Manager | 7 個 secret，每次冷啟動存取 | 免費額度內 |
| Web Push | — | 0 |
| Twilio 語音 | 僅逾時升級時 | 每通數元台幣 |
| 地圖圖磚 | MapTiler 免費層 | 0 |

設定 GCP 預算告警（如每月 NT$100）以防意外。

---

## 12. 風險與對策

| 風險 | 對策 |
|---|---|
| 家人裝不起 PWA | 當面協助安裝一次；未安裝仍可看頁面；語音來電不依賴安裝 |
| 夜間推播被靜音 | Level 2 語音來電；家人將號碼設為最愛 |
| 飛行 / 無訊號造成假警報 | 打卡時預告 `nextHours`；`/offline` 端點 |
| 忘記結案 | `endAt + 24h` 自動結案 |
| 讀取 token 外流 | 可個別撤銷；`Referrer-Policy`；無副作用 GET |
| 寫入 token 外流 | 換 Secret 重新部署；捷徑內 token 不會顯示於分享 |
| 排程重複觸發 | `alertLevel` / `lastAlertAt` 狀態機保證冪等 |
| Functions 冷啟動 | 捷徑背景執行不影響體驗；`/me` 備援頁顯示送出中狀態 |

---

## 13. 開發順序（估 3–4 個工作天）

| 步驟 | 內容 | 工時 |
|---|---|---|
| 1 | Firebase 專案、Blaze、Secrets、`firebase.json`、規則與索引 | 0.5 天 |
| 2 | `api` Function：trips / checkin / watchers / subscribe / manifest | 1 天 |
| 3 | 家人頁：onSnapshot、地圖、時間軸、環境偵測、SW、推播訂閱 | 1 天 |
| 4 | `/me` 管理頁 + iOS 捷徑 | 0.5 天 |
| 5 | `checkOverdue` 狀態機 + Web Push + Twilio | 0.5 天 |
| 6 | 實機測試：iPhone 安裝流程、睡眠模式下推播、來電 | 0.5 天 |

### 13.1 驗證清單

- [ ] 捷徑從鎖定畫面一鍵打卡，家人頁 3 秒內更新
- [ ] 從 LINE 點連結 → 提示用 Safari 開啟 → 加到主畫面 → 開啟通知，全程有引導
- [ ] 加到主畫面後開啟仍帶 token
- [ ] 手動把 `nextDeadlineAt` 改成過去，15 分鐘內收到 Level 1 推播
- [ ] 3 小時後收到來電（測試時可暫調 `ESCALATE_AFTER_H`）
- [ ] 打卡後 `alertLevel` 歸零並收到「已恢復回報」
- [ ] 預告離線 16 小時，期間排程不警報
- [ ] 刪除主畫面圖示後，後端下次推送自動清除該訂閱
- [ ] 撤銷某位家人 token 後，其頁面 onSnapshot 收到文件不存在

---

## 14. 待決事項

| # | 項目 |
|---|---|
| 1 | `ESCALATE_AFTER_H` 與 `MAX_ALERTS` 的實際值，需與家人溝通後定 |
| 2 | 家人是否都是 iPhone（影響安裝引導文案與 Declarative Web Push 覆蓋率） |
| 3 | 是否需要 Android 端捷徑（Tasker）或只用 `/me` 備援 |
| 4 | 打卡紀錄是否要保留期限（個人用，可先不設 TTL） |
