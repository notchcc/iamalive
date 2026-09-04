# iamalive — 個人用旅行報平安 Web App 技術規格書

| 項目 | 內容 |
|---|---|
| 文件版本 | v0.7 |
| 日期 | 2026-09-04 |
| 狀態 | 設計定稿，待決事項已全部定案，可進入開發 |

### 版本歷史

| 版本 | 變更 |
|---|---|
| v0.1 | LIFF + LINE 官方帳號多使用者版（已廢棄） |
| v0.2 | 個人用、純 PWA、Web Push 通知、capability token |
| v0.3 | 通知改為官方帳號推播到家人 LINE 群組；移除 PWA 推播層；打卡入口以 iOS 捷徑為主 |
| v0.4 | 待決事項定案：警報參數與安靜時段補發（台北時間）、打卡靜默只推狀態變化、位置訊息附家人頁連結、保留家人頁；新增旅人時區與台北雙時鐘 |
| v0.5 | 新增**航段**（多筆，當地時間輸入），飛行中不警報、期限順延至降落後 3 小時；打卡紀錄加入**反向地理編碼城市**與經緯度；行程開始前不警報；webhook 未綁定時自動綁定首個群組 |
| v0.6 | 新增**照片打卡**：捷徑 D（分享表單）與 `/me` 上傳，以照片 EXIF 的 GPS 與拍攝時間為打卡資訊；照片存私有 GCS bucket，家人頁經 token 驗證取圖並顯示縮圖 |
| v0.7 | **多使用者**：`/me` 改用 **LINE Login**（session cookie），捷徑改用可撤銷的 **API 金鑰**；行程、群組綁定、金鑰皆以 LINE userId 為範圍；群組以**綁定碼**綁定；不做邀請名單（任何 LINE 帳號可登入） |

---

## 1. 概述

### 1.1 目標

1. 旅行者（即開發者本人）一鍵打卡，5 秒內完成，不需開啟任何網頁。
2. 家人**零安裝、零登入、零設定**：狀態變化直接推到既有的家人 LINE 群組，地圖與時間軸點連結即看。
3. 逾時未打卡時群組收到警報，持續未回報時定期重複，有次數上限；半夜發出的警報早上 08:00（台北）補發一次。
4. 長途飛行、無訊號路段可**預告離線**，避免假警報。
5. 家人頁同時顯示旅人當地時間與台北時間，避免時差誤判。

### 1.2 非目標

| 項目 | 原因 |
|---|---|
| 多使用者 / 多旅行者 | 個人使用，沒有註冊流程 |
| 背景自動定位 | 網頁與捷徑皆無法持續背景執行；打卡一律由使用者主動觸發 |
| 每次打卡推播群組 | 已決定只推狀態變化，打卡靜默；家人以網頁或「在哪」指令查看 |
| 1 對 1 LINE 推播 | 需每位家人加好友；群組推播不需要 |
| Web Push / PWA | 已由 LINE 群組推播取代 |
| SOS / 報警串接 | 非救援工具 |

### 1.3 設計前提

- **一個 LINE 官方帳號（Messaging API channel）**，個人用免費方案。它以成員身分加入家人群組，推播以群組為單位計費。
- **所有寫入都經過 Cloud Functions**，前端不直接寫 Firestore。
- **旅行者身分用 capability token**，家人頁用讀取 token 直接讀 Firestore 投影文件。
- **時間基準**：伺服器內部一律 UTC timestamp；所有面向家人的顯示（LINE 訊息、家人頁）以 **Asia/Taipei** 為主，旅人當地時間為輔；安靜時段判定用 Asia/Taipei。
- **Firebase 必須為 Blaze 方案**，實際用量在免費額度內，需設預算告警。

---

## 2. 系統架構

```
 旅行者手機                                   家人
 ┌───────────────────┐                        ┌────────────────────────┐
 │ iOS 捷徑「我平安」  │                        │ LINE 家人群組           │
 │  取得位置 → POST   │                        │  ← 官方帳號推播         │
 ├───────────────────┤                        │  · 逾時警報 / 恢復      │
 │ LINE 群組傳位置     │──┐                     │  · 離線預告 / 起訖      │
 │ （備援）            │  │ webhook             │  · 「在哪」「行程」→ reply│
 ├───────────────────┤  │                     ├────────────────────────┤
 │ /me 管理頁（備援）  │  │                     │ 家人頁 /w/{readToken}   │
 └────────┬──────────┘  │                     │  雙時鐘 + 地圖 + 時間軸  │
          │ X-Write-Token│                     └──────────┬─────────────┘
          ▼             ▼                                │ onSnapshot
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
| 時區 | `tz-lookup`（座標 → IANA 時區，離線、體積小） | 每筆打卡推算旅人時區 |
| 時間格式 | `Intl.DateTimeFormat` / `date-fns-tz` | 前後端皆以 IANA 時區格式化 |
| 打卡入口 | iOS 捷徑（主）、LINE 位置訊息（輔）、網頁（備援） | 見 §6 |
| 照片 | 私有 GCS bucket（`PHOTO_BUCKET`，asia-east1，公開存取防護 enforced） | 只有 Functions 服務帳號有 objectAdmin；家人頁經 `/api/p/{token}/{id}` 取圖 |
| 秘密 | Firebase Secret Manager (`defineSecret`) | 不放 Firestore、不進 repo |

---

## 3. 身分與憑證

| 角色 | 憑證 | 用途 | 儲存位置 |
|---|---|---|---|
| 旅行者（網頁） | LINE Login → session JWT（HS256，30 天）放在 `__session` cookie | `/me` 全部操作 | HttpOnly cookie（Hosting 只轉送此名稱的 cookie） |
| 旅行者（捷徑） | API 金鑰 `ak_…`（`X-Api-Key`），每人最多 10 把、可個別撤銷 | 打卡、預告離線 | 捷徑；伺服器只存 SHA-256 雜湊 `apiKeys/{hash}` |
| 旅行者（LINE 群組） | 群組綁定 `groups/{groupId}.ownerUid` | 位置訊息打卡、`離線 / 結束 / 備註` 指令 | 由「綁定 123456」建立 |
| 家人（網頁） | `readToken`（Firestore 文件 ID） | 讀取 `views/{readToken}` 與照片 | 連結網址 |
| 家人（LINE） | 群組成員身分 | 收推播、「在哪」「行程」 | 無需任何設定 |
| 官方帳號 | `LINE_CHANNEL_SECRET`、`LINE_CHANNEL_ACCESS_TOKEN` | 驗證 webhook、push/reply | Secret |
| LINE Login | `LINE_LOGIN_CHANNEL_ID`（env）、`LINE_LOGIN_CHANNEL_SECRET`、`SESSION_SECRET` | 授權碼交換、驗 ID token、簽 session | Secret |
| 過渡 | `WRITE_TOKEN` + `TRAVELER_LINE_UID` | 舊 `X-Write-Token` 視為該使用者的金鑰 | 捷徑全部換金鑰後移除 |

登入流程：`GET /api/auth/line/start`（簽章 `state`，10 分鐘）→ LINE 授權 → `GET /api/auth/line/callback` 以 channel secret 換 token、呼叫 LINE verify 端點驗 ID token 與 `aud` → upsert `users/{userId}` → 設 cookie → 導回 `/me`。cookie 身分的變更請求需同站（`Sec-Fetch-Site` / `Origin` 檢查）。**LINE Login channel 與 Messaging API channel 必須在同一個 Provider**，userId 才一致。

---

## 4. 資料模型（Firestore）

### 4.1 使用者、群組、金鑰

| 集合 | 說明 |
|---|---|
| `users/{lineUserId}` | `displayName`、`pictureUrl`、`createdAt`、`lastLoginAt` |
| `groups/{lineGroupId}` | `ownerUid`、`boundAt`。一人一個群組；重綁會解除舊的；`leave` 事件刪除 |
| `bindCodes/{6位數}` | `uid`、`expiresAt`（10 分鐘）。`/me` 產生，群組內由本人輸入「綁定 123456」消耗 |
| `apiKeys/{sha256(key)}` | `uid`、`label`、`prefix`、`createdAt`、`lastUsedAt`（每小時最多更新一次） |
| `config/line` | 全域推播額度：`monthKey`、`pushCount`（所有使用者共用） |

### 4.2 `trips/{tripId}`（僅 Functions 讀寫）

| 欄位 | 型別 | 說明 |
|---|---|---|
| `ownerUid` | string | 擁有者 LINE userId；所有 API 以此為範圍，非擁有者一律 404 |
| `title` | string | 行程名稱 |
| `startAt` / `endAt` | timestamp | 行程起訖 |
| `intervalHours` | number | 預設打卡間隔（1–72） |
| `status` | string | `active` / `completed` |
| `travelerTz` | string | 旅人目前時區（IANA），建立時預設 `Asia/Taipei`，每次打卡以座標更新 |
| `lastCheckinAt` | timestamp \| null | |
| `lastCheckinGeo` | geopoint \| null | |
| `lastCheckinPlace` | string \| null | 最後位置「城市, 國家」（反向地理編碼） |
| `nextDeadlineAt` | timestamp | **下一個期限**，建立時 = `max(startAt, now) + intervalHours`；每次打卡 = `max(now, startAt) + hours` |
| `flights` | array\<FlightSegment\> | 航段，依 `departAt` 排序，上限 20（見 4.2.1） |
| `offlineUntil` | timestamp \| null | 預告離線至此時間，期間不警報 |
| `alerted` | boolean | 本期限內是否已發過警報，打卡後歸零 |
| `alertCount` | number | 本期限內已發的一般警報數（不含早晨補發），打卡後歸零 |
| `lastAlertAt` | timestamp \| null | |
| `morningResendDue` | boolean | 上一則警報落在安靜時段，待 08:00 補發 |
| `morningResent` | boolean | 本期限內已補發過（每次事件最多一次） |
| `readTokens` | array\<string\> | 家人頁 token 清單 |
| `createdAt` / `updatedAt` | timestamp | |

#### 4.2.1 `FlightSegment`

| 欄位 | 型別 | 說明 |
|---|---|---|
| `flightNo` | string | 航班號碼，大寫 |
| `fromCity` / `toCity` | string | 起降城市（顯示用） |
| `fromTz` / `toTz` | string | 起降城市 IANA 時區 |
| `departAt` / `arriveAt` | timestamp | 起降時間（UTC）。API 以「當地時間字串 + 時區」輸入，伺服器以 `zonedToUtc` 轉換（含夏令時間） |

航段對警報的影響（`overdue-logic.ts`）：
- **飛行窗** = 起飛前 `BOARDING_LEAD_H`（2 小時）到降落。窗內不警報。
- **期限順延**：若 `nextDeadlineAt` 落在某航段的〔飛行窗起點, 降落 + `LANDING_GRACE_H`（3 小時）〕內，有效期限改為「降落 + 3 小時」；依起飛時間排序連續套用，轉機自然銜接。
- 落地後 3 小時內未打卡才警報，警報文案附「BR61 預計已於 台北 HH:mm（當地 HH:mm）降落 維也納」。

### 4.3 `trips/{tripId}/checkins/{checkinId}`（僅 Functions 寫入）

| 欄位 | 型別 | 說明 |
|---|---|---|
| `geo` | geopoint | 座標 |
| `accuracy` | number \| null | 公尺；捷徑與 LINE 位置訊息為 null |
| `source` | string | `shortcut` / `line` / `web-gps` / `manual` / `photo` |
| `tz` | string | 該座標的 IANA 時區，伺服器以 `tz-lookup` 推算 |
| `place` | string \| null | 「城市, 國家」，打卡時以 OSM Nominatim 反向地理編碼（4 秒逾時，失敗為 null，顯示時退回時區城市名） |
| `note` | string | ≤ 200 字，可空 |
| `nextHours` | number \| null | 本次預告「下次幾小時後回報」 |
| `photoId` | string \| null | 照片物件 ID（GCS `photos/{tripId}/{photoId}`），無照片為 null |
| `takenAt` | timestamp \| null | 照片 EXIF 拍攝時間；**期限仍以 `createdAt` 計算**，此欄位只用於顯示 |
| `createdAt` | timestamp | 伺服器時間 |
| `clientAt` | timestamp \| null | 裝置時間 |

### 4.4 `views/{readToken}`（家人頁即時讀取的投影）

| 欄位 | 型別 | 說明 |
|---|---|---|
| `tripId` | string | |
| `label` | string | 家人稱呼 |
| `title` / `status` | string | 複製自 trip |
| `travelerTz` | string | 複製自 trip，家人頁雙時鐘用 |
| `lastCheckinAt` / `nextDeadlineAt` / `offlineUntil` | timestamp \| null | 複製自 trip |
| `alerted` | boolean | 複製自 trip，家人頁頂部狀態用 |
| `flights` | array\<FlightSegment\> | 複製自 trip，家人頁航段區塊與飛行中狀態用 |
| `recent` | array\<map\> | 最近 100 筆 `{lat, lng, acc, src, tz, place, note, photoId, takenAt, at}` |
| `updatedAt` | timestamp | |

每次打卡、預告離線、警報狀態變化、結案，Function 在同一個 batch 內更新 `trips` 與該行程所有 `views/*`。

### 4.5 索引

- `trips`：複合 `status ASC, nextDeadlineAt ASC`（排程）、`ownerUid ASC, status ASC`（進行中行程）、`ownerUid ASC, createdAt DESC`（列表）
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

公開端點：`/health`、`/p/*`、`/auth/line/*`、`/auth/logout`。其餘需 `__session` cookie 或 `X-Api-Key`。錯誤一律 `{ error: string }`。

| Method | Path | 用途 |
|---|---|---|
| GET | `/api/auth/line/start` | 導向 LINE 授權 |
| GET | `/api/auth/line/callback` | 授權回呼，設 cookie 後導回 `/me` |
| POST | `/api/auth/logout` | 清 cookie |
| GET | `/api/auth/me` | 目前身分（uid、kind、名稱、頭像） |
| GET / POST / DELETE | `/api/keys[/:id]` | 列出 / 產生（明文只回一次）/ 撤銷金鑰 |
| POST | `/api/line/bind-code` | 產生 6 位數綁定碼（10 分鐘） |
| POST | `/api/line/unbind` | 解除自己的群組綁定 |


| Method | Path | 用途 | 主要邏輯 |
|---|---|---|---|
| POST | `/api/checkin` | 打卡 | 見 5.2 |
| POST | `/api/trips` | 建立行程 | 寫 `trips`；推「行程開始」 |
| POST | `/api/trips/:id/end` | 結束行程 | `status = completed`，同步 views，推「行程結束」 |
| POST | `/api/trips/:id/offline` | 預告離線 | `{ hours }` → `offlineUntil`、`nextDeadlineAt = offlineUntil + interval`，推「將離線至 T」 |
| POST | `/api/checkin/photo` | 照片打卡 | `multipart/form-data`：`photo`（檔案，≤ 8 MB，jpeg/png/heic/webp）+ `lat`、`lng`、`accuracy?`、`note?`、`nextHours?`、`takenAt?`、`clientAt?`；存入 GCS 後走與 `/checkin` 相同流程，`source = photo` |
| GET | `/api/p/:readToken/:photoId` | 家人頁取圖 | **不需寫入 token**；驗證 `views/{readToken}` 存在且照片屬於該行程後串流回傳，`Cache-Control: private, max-age=86400` |
| PUT | `/api/trips/:id/flights` | 整批更新航段 | `{ flights: [{ flightNo, fromCity, fromTz, departLocal, toCity, toTz, arriveLocal }] }`，`*Local` 為 `YYYY-MM-DDTHH:mm` 當地時間；驗證時區有效、降落晚於起飛、單段 ≤ 30 小時 |
| POST | `/api/trips/:id/watchers` | 新增家人頁連結 | 產生 readToken，建立 `views/{token}`，回傳連結 |
| DELETE | `/api/trips/:id/watchers/:token` | 撤銷連結 | 刪 view |
| GET | `/api/trips/active` | 取目前 active 行程 | 捷徑與 `/me` 用 |
| GET | `/api/status` | 群組綁定狀態、本月已用額度 | `/me` 顯示 |

### 5.2 `POST /api/checkin`

```
Request:  { lat, lng, accuracy?, source, note?, nextHours?, clientAt? }
Response: { ok: true, nextDeadlineAt, tz, pushed: boolean }
```

1. 驗證 token、座標範圍、`note.length ≤ 200`、`nextHours ∈ [1, 168]`。
2. 找 `status == active` 的行程（無則 409）。
3. `tz = tzLookup(lat, lng)`。
4. batch：新增 checkin（含 `tz`）；更新 trip（`lastCheckinAt`、`lastCheckinGeo`、`travelerTz = tz`、`nextDeadlineAt = now + (nextHours ?? intervalHours)`、`offlineUntil = null`、`alerted = false`、`alertCount = 0`、`morningResendDue = false`、`morningResent = false`）；更新所有 views。
5. **打卡本身不推群組。** 唯一例外：打卡前 `alerted == true`，推「已恢復回報」（位置訊息 + 連結文字），`pushed = true`。

### 5.3 Function `lineWebhook`（`POST /line/webhook`，獨立 URL）

- 驗證 `x-line-signature`（HMAC-SHA256，Channel Secret），失敗回 401。
- 一律先回 200，再非同步處理事件。
- 只服務群組事件。`join`：回覆綁定說明；`leave`：刪除 `groups/{gid}`。
- 「綁定 123456」：任何群組都處理；碼須有效且由產生者本人輸入；成功後該人先前綁的其他群組解除。
- 其餘事件：`groups/{gid}` → `ownerUid` → 該人的進行中行程。位置訊息與 `離線 / 結束 / 備註` 只接受擁有者；「在哪」「行程」任何成員可用。未綁定群組只在有人輸入指令時回覆提示，其餘靜默。

| 事件 | 處理 |
|---|---|
| `join` | 寫 `config/line.groupId`，reply「已加入，之後會在這裡通知」 |
| `leave` | 清空 `groupId`；`/me` 顯示未綁定 |
| `message.location` 且 `source.userId == TRAVELER_LINE_UID` | 視為打卡，`source = line`，`note = title/address`；依 §5.2 流程；reply「已記錄 · 當地 HH:mm（台北 HH:mm）· 下次期限 台北 HH:mm」 |
| `message.text` 來自旅行者 | `離線 16` → 預告離線；`結束` → 結案；`備註 xxx` → 補到最後一筆打卡 |
| `message.text` 來自任何成員，含 `在哪` / `平安` | reply 最後位置訊息 + 文字（距今、當地與台北時間、家人頁連結） |
| `message.text` 來自任何成員，含 `行程` | reply 最近 5 筆打卡的文字清單（台北時間 + 當地時間 + 備註）+ 家人頁連結 |
| 其他 | 忽略 |

reply 免費，不計額度。非旅行者傳的位置訊息忽略。

---

## 6. 旅行者打卡入口

### 6.1 iOS 捷徑（主要路徑）

#### 6.1.1 評估結論

可行且為最佳主入口：不經網頁、無登入、無冷啟動等待，整段「取得位置 → POST → 顯示結果」通常 2–5 秒。

| 面向 | 狀況 | 對策 |
|---|---|---|
| 觸發方式 | 動作按鈕、控制中心（iOS 18）、背面輕點、Siri 語音可在不開啟捷徑 App 下執行；主畫面圖示會短暫跳 App | 主要用動作按鈕或控制中心 |
| 定位精度值 | 捷徑位置物件無穩定的水平精度欄位 | `accuracy = null`，家人頁不畫精度圈，標「來源：捷徑」 |
| 定位逾時 | 「取得目前位置」無法設逾時 | 精確度選「最佳」；卡住時取消改用 LINE 位置或網頁選點 |
| 錯誤處理 | 無 try/catch，POST 失敗只有系統錯誤橫幅；無離線排隊 | 接受；稍後重按。計畫中的無訊號段用預告離線 |
| 無網路 | GPS 可定位但 POST 失敗 | 同上 |
| 時區 | 不需捷徑回報，伺服器由座標推算 | — |
| token 安全 | 寫入 token 明文存在捷徑內 | 不以 iCloud 連結分享此捷徑；外流時換 Secret 重新部署 |
| 自動化 | 定時自動化可自動執行捷徑 | **只用於提醒，禁止用於自動送出位置** |

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
4. 顯示通知 「已打卡，下次期限（台北）：{nextDeadlineAt}」
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

### 6.1.3 捷徑 D「用照片報平安」（分享表單）

- 拍完照後手動觸發：相機縮圖或 Photos → 分享 → 捷徑；也可從主畫面執行並選照片。**不做自動觸發**（iOS 沒有「新照片」事件，「相機關閉」代理觸發不可靠且會重複）。
- 流程：取影像「位置」（EXIF GPS）→ 無則退回目前定位 → 取「拍攝日期」→ 縮到 1600px、轉 JPEG 不保留詮釋資料 → 表單 POST `/api/checkin/photo`。
- 詳細步驟見 `shortcuts/README.md`。

### 6.2 LINE 群組位置訊息（輔助路徑）

- 在家人群組按「＋ → 位置資訊 → 傳送」，約 3 次點擊、5–8 秒。
- webhook 收到後視為打卡（§5.3），只 reply 確認，不另外 push。
- 家人在聊天室直接看到位置；任何手機皆可。

### 6.3 `/me` 網頁（備援與管理）

- 首次輸入寫入 token，存 localStorage。
- 「用瀏覽器定位打卡」：`getCurrentPosition({ enableHighAccuracy: true, timeout: 10000, maximumAge: 60000 })`，`source = web-gps`，此路徑有精度值。
- 「地圖選點打卡」：定位失敗時的手動路徑，`source = manual`。
- 建立 / 結束行程、預告離線、新增 / 撤銷家人連結、顯示群組綁定狀態與本月額度。
- **用照片打卡**卡片：`<input type=file accept=image/*>`（iPhone 顯示拍照 / 圖庫），瀏覽器端以 `exifr` 讀 GPS、拍攝時間、`GPSHPositioningError`，無 GPS 時可改用目前定位；`createImageBitmap` 縮圖至 1600px 後 multipart 上傳。iOS Safari 選圖是否保留 GPS EXIF 因版本而異，需實機確認。
- **登入**：未登入只顯示「用 LINE 登入」；已登入右上顯示名稱與頭像、登出。
- **家人 LINE 群組**卡片：未綁定時顯示三步驟（邀請官方帳號、產生綁定碼、本人在群組輸入）；已綁定可解除。
- **捷徑金鑰**卡片：列表（標籤、前 8 碼、建立與最後使用時間）、產生（只顯示一次、複製）、撤銷。
- **航段**卡片：列表與刪除；新增表單含航班號碼、起飛城市 / 時區 / 當地時間、降落城市 / 時區 / 當地時間；時區欄為 datalist（常用城市中文對照），選時區自動帶入城市名，新增後下一段的起飛欄自動帶入上一段目的地。
- 內嵌與家人頁相同的地圖與時間軸元件（自用回顧）。

---

## 7. 逾時偵測（`checkOverdue`，每 15 分鐘）

### 7.1 參數

| 參數 | 值 | 說明 |
|---|---|---|
| 掃描頻率 | 15 分鐘 | 實際延遲 ≤ 15 分鐘 |
| `REPEAT_H` | 3 | 一般重複警報間隔 |
| `MAX_ALERTS` | 4 | 單一期限內一般警報上限（覆蓋逾時後約 9 小時） |
| 安靜時段 | **台北時間 23:00–07:00** | 期間警報照常發送，但會標記待補發 |
| 早晨補發 | **台北時間 08:00** 後第一次掃描 | 每次事件最多 1 次，不計入 `MAX_ALERTS` |
| 自動結案 | `endAt + 24h` | 避免忘記結案後永久警報 |
| 行程開始前 | 不警報 | 出發前的測試打卡不會觸發 |
| `BOARDING_LEAD_H` | 2 | 起飛前多久起算飛行中 |
| `LANDING_GRACE_H` | 3 | 降落後多久內須回報 |

每次逾時事件最多 5 則（4 則一般 + 1 則補發）。

### 7.2 邏輯

```javascript
const TZ = 'Asia/Taipei';
const hourInTaipei = (ts) => Number(new Intl.DateTimeFormat('en', { hour: 'numeric', hour12: false, timeZone: TZ }).format(ts));
const inQuietHours = (ts) => { const h = hourInTaipei(ts); return h >= 23 || h < 7; };

export const checkOverdue = onSchedule(
  { schedule: 'every 15 minutes', timeZone: TZ, region: 'asia-east1', secrets: [...] },
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
      const quietNow = inQuietHours(now.toDate());

      // 早晨補發：上一則落在安靜時段，現在已過 08:00，且本事件尚未補發
      if (t.morningResendDue && !t.morningResent && hourInTaipei(now.toDate()) >= 8) {
        await pushGroup(alertMessage(t, overdueH, { morning: true }));
        await doc.ref.update({ morningResendDue: false, morningResent: true, lastAlertAt: now });
        continue;
      }

      let send = false, isFinal = false;
      if (!t.alerted) {
        send = true;
      } else if (sinceLast >= REPEAT_H && t.alertCount < MAX_ALERTS) {
        send = true;
        isFinal = t.alertCount + 1 === MAX_ALERTS;
      }
      if (!send) continue;

      await pushGroup(alertMessage(t, overdueH, { final: isFinal }));
      await doc.ref.update({
        alerted: true,
        alertCount: t.alertCount + 1,
        lastAlertAt: now,
        morningResendDue: quietNow || t.morningResendDue,
      });
      await syncViews(doc.id, { alerted: true });
    }
  });
```

### 7.3 警報訊息

一次 push 兩個物件（計 1 則）：

1. **位置訊息**：最後位置。`title` = 「⚠️ {title} 尚未回報」，`address` = 「最後回報 台北 MM/DD HH:mm（當地 HH:mm）」。
2. **文字**：「已超過預定回報時間 X 小時。台北現在 HH:mm，{城市時區}當地 HH:mm。\n查看地圖與時間軸：{家人頁連結}」
   - 早晨補發加前綴「（早安補發）」。
   - 最後一則加後綴「這是最後一次自動提醒，之後請直接聯絡本人或查看家人頁。」

文案只說「尚未回報」，不說「出事」。

---

## 8. 家人頁（`/w/{readToken}`）

### 8.1 版面

```
┌──────────────────────────────────────┐
│ 台北  09-05 14:32   │  東京  09-05 15:32 │  ← 雙時鐘，每秒更新
├──────────────────────────────────────┤
│ 最後回報：3 小時前                     │  ← 大字；逾時變紅並顯示「已超過 X 小時」
│ 台北 11:20 · 當地 12:20 · 備註「抵達民宿」│    離線預告時顯示「預告離線至 台北 HH:mm」
│ 下次期限：台北 23:20                   │
├──────────────────────────────────────┤
│ [地圖：所有打卡點，最後一點高亮]        │
├──────────────────────────────────────┤
│ 時間軸                                │
│  09-05 11:20 台北 (12:20 當地) 已報平安 │
│  09-04 22:05 台北 (23:05 當地) 抵達民宿 │
│  ...                                  │
└──────────────────────────────────────┘
```

### 8.1.1 航段與地點

- 狀態卡在飛行中改為藍色「✈️ 飛行中 BR61」，副標「台北 → 維也納，預計 台北 MM/DD HH:mm（維也納 HH:mm）降落，落地後 3 小時內回報」；非飛行中且有下一段時顯示「下一段 … 起飛」。
- 狀態卡下方「航段」區塊列出所有航段（各地當地時間）與狀態：已降落 / 飛行中 / 未起飛。
- 有照片的打卡卡片左側顯示 96px 縮圖，點開看原圖（同一 token 保護的網址）；拍攝時間與上傳時間相差 5 分鐘以上時顯示「拍攝於 …」。地圖 popup 亦顯示縮圖。
- 最後回報行與時間軸每張卡片顯示 **📍 城市, 國家**（`place`，查不到退回時區城市名）與 **經緯度**（小數 5 位，連到 Google Maps）。地圖 popup 同。

### 8.2 雙時鐘規則

- 左側固定 `Asia/Taipei`；右側為 `views.travelerTz`，標籤顯示時區的城市名（IANA 最後一段，`Asia/Tokyo` → 「東京」，以對照表翻譯，無對照則顯示原字串）與 UTC 偏移。
- 兩者相同時只顯示一個時鐘並註明「與台北同時區」。
- 時間軸每筆用該筆 checkin 的 `tz` 顯示當地時間，不用目前的 `travelerTz`（跨時區行程才正確）。
- 全部以 `Intl.DateTimeFormat(..., { timeZone })` 格式化，不依賴瀏覽器本機時區。

### 8.3 其他

- 純網頁，從 LINE 內建瀏覽器開啟即可，不需安裝。
- 地圖：有精度值者畫精度圈；`shortcut` / `line` 來源標示「精度未知」；`manual` 以不同圖示標示。
- 資料來源：`onSnapshot(doc('views', token))`。
- Hosting header：`Referrer-Policy: same-origin`、`Cache-Control: no-store`。
- 不放任何 `og:` 位置資訊；GET 無副作用。

---

## 9. LINE 通知

### 9.1 訊息一覽

| 事件 | 觸發 | 物件 | 計額度 |
|---|---|---|---|
| 行程開始 | `POST /api/trips` | 文字（標題、起訖、間隔、家人頁連結） | push，1 則 |
| 預告離線 | `/offline` 或 `離線 N` 指令 | 文字「將離線至 台北 HH:mm（當地 HH:mm），期間不會警報」 | push，1 則 |
| 逾時警報 | `checkOverdue` | 位置訊息 + 文字（含連結） | push，1 則 |
| 早晨補發 | `checkOverdue` | 同上 | push，1 則 |
| 恢復回報 | 警報後首次打卡 | 位置訊息 + 文字「已恢復回報 · 台北 HH:mm（當地 HH:mm）· {連結}」 | push，1 則 |
| 行程結束 | `/end`、`結束` 指令、自動結案 | 文字 + 家人頁連結 | push，1 則 |
| 打卡 | 任一路徑 | **不推** | 0 |
| 打卡（LINE 位置路徑） | webhook | reply 確認 | reply，免費 |
| 「在哪」 | 任何成員 | reply 位置訊息 + 文字 | reply，免費 |
| 「行程」 | 任何成員 | reply 最近 5 筆清單 | reply，免費 |

- 群組為單一收件對象，一次 push 不論人數只計 1 則。
- 所有訊息內時間格式：「台北 MM/DD HH:mm（當地 HH:mm）」。
- 「在哪」回覆含最後位置城市、飛行中或下一段航班；「行程」回覆每筆含城市；逾時警報含最近 24 小時內預計已降落的航段；「行程開始」列出前 6 段航段。

### 9.2 額度

估算：一趟行程約 2 則起訖 + 0–2 則離線 + 偶發警報，**每趟約 5 則**。免費 200 則/月幾乎不可能用完。仍保留 `config/line.pushCount` 計數與 `/me` 顯示；`pushCount ≥ 190` 時只保留警報與恢復。

### 9.3 官方帳號設定（一次性）

1. LINE Developers：建立 Provider → Messaging API channel。
2. OA Manager → 回應設定：關閉自動回應與歡迎訊息；**開啟「允許加入群組・多人聊天室」**。
3. Developers Console → Messaging API：設定 Webhook URL，啟用 Use webhook；發行長效 Channel access token。
4. 把 OA 邀請進家人群組 → `join` → `groupId` 寫入 `config/line`。
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

`lineWebhook` 不經 Hosting rewrite，直接用 Functions 的 URL，以 `req.rawBody` 驗簽。

### 10.2 Secrets

```
firebase functions:secrets:set WRITE_TOKEN
firebase functions:secrets:set LINE_CHANNEL_SECRET
firebase functions:secrets:set LINE_CHANNEL_ACCESS_TOKEN
firebase functions:secrets:set TRAVELER_LINE_UID
```

### 10.3 Functions 設定

- 2nd gen、`region: 'asia-east1'`、`minInstances: 0`、`maxInstances: 3`、`timeoutSeconds: 60`。
- `checkOverdue` 的 `onSchedule` 指定 `timeZone: 'Asia/Taipei'`。
- 專案目錄：`web/`、`functions/`、`firestore.rules`、`firestore.indexes.json`、`shortcuts/`。

---

## 11. 成本（Blaze，個人用量）

| 項目 | 估算 | 費用 |
|---|---|---|
| Firestore | 每月數千次讀寫 | 免費額度內 |
| Functions | 排程 2,880 次/月 + webhook + 打卡 | 免費額度內 |
| Hosting | < 1 GB | 免費額度內 |
| Cloud Scheduler | 1 個 job | 免費 |
| Secret Manager | 4 個 secret | 免費額度內 |
| LINE 官方帳號 | 輕用量方案，每趟約 5 則 | 免費 |
| 地圖圖磚 | MapTiler 免費層 | 0 |

設定 GCP 預算告警。

---

## 12. 風險與對策

| 風險 | 對策 |
|---|---|
| bot 被移出群組 | `leave` 清空 groupId；`/me` 紅字；打卡回應 `pushed: false` |
| 夜間警報沒人看到 | 台北 08:00 早晨補發一次 |
| 家人不知道打卡有沒有發生（打卡靜默） | 家人頁大字「最後回報距今」；群組「在哪」「行程」指令免費查 |
| 時差誤判 | 家人頁雙時鐘；所有訊息同時標台北與當地時間 |
| 時區推算錯誤（海上、邊界） | `tz-lookup` 對海域回傳 `Etc/GMT±N`，仍可顯示偏移；家人頁顯示 UTC 偏移作為輔助 |
| 飛行 / 無訊號造成假警報 | `nextHours` 預告；`離線 N` 指令；捷徑 C |
| 忘記結案 | `endAt + 24h` 自動結案 |
| 捷徑內寫入 token 外流 | 不分享捷徑；換 Secret 重新部署 |
| 捷徑無精度值 | 家人頁標「精度未知」 |
| 網頁 token 外流 | 可個別撤銷；`Referrer-Policy`；無副作用 GET |
| bot 被拉進別的群組 | 只處理已綁定 groupId |
| 排程重複觸發 | `alerted` / `lastAlertAt` / `morningResent` 狀態機冪等 |
| 他人在群組傳位置 | 比對 `TRAVELER_LINE_UID`，忽略他人 |

---

## 13. 開發順序（估 4 個工作天）

| 步驟 | 內容 | 工時 |
|---|---|---|
| 1 | Firebase 專案、Blaze、Secrets、規則與索引；LINE OA 與 channel 設定（§9.3） | 0.5 天 |
| 2 | `api` Function：trips / checkin（含 tz 推算）/ offline / watchers / status；views 投影 | 1 天 |
| 3 | `lineWebhook`：驗簽、join/leave、位置訊息打卡、文字指令、「在哪」「行程」reply；`pushGroup` 與訊息模板（雙時區格式） | 1 天 |
| 4 | 家人頁：雙時鐘、onSnapshot、地圖、時間軸（同元件供 `/me` 使用） | 0.75 天 |
| 5 | `/me` 管理頁 + 捷徑 A/B/C 製作與說明文件 | 0.5 天 |
| 6 | `checkOverdue` 狀態機（含安靜時段與早晨補發）+ 實機測試 | 0.5 天 |

### 13.1 驗證清單

- [ ] 捷徑 A 從動作按鈕執行，5 秒內家人頁更新，群組**沒有**收到訊息
- [ ] 在東京座標打卡，`tz = Asia/Tokyo`，家人頁右側時鐘顯示「東京」且比台北快 1 小時
- [ ] 時間軸中台北座標與東京座標的打卡各自顯示正確當地時間
- [ ] 捷徑 B 帶 `nextHours = 16`，回應的下次期限為台北時間
- [ ] 在群組傳 LINE 位置訊息，收到 reply 含當地與台北時間，`pushCount` 不增加
- [ ] 家人打「在哪」與「行程」，bot reply 正確且 `pushCount` 不增加
- [ ] 他人在群組傳位置，無任何反應
- [ ] 手動把 `nextDeadlineAt` 改成過去，15 分鐘內群組收到警報（位置訊息 + 含連結文字）
- [ ] 每 3 小時重複，第 4 則含「最後一次自動提醒」，之後停止
- [ ] 把 `lastAlertAt` 設為台北 02:00 並標記 `morningResendDue`，08:00 後第一次掃描收到「早安補發」，且只補發一次
- [ ] 警報後打卡，收到「已恢復回報」，`alerted`、`alertCount`、`morningResent` 全部歸零
- [ ] `離線 16` 指令生效，期間排程不警報
- [ ] 把 bot 移出群組，`/me` 顯示未綁定；重新邀請後自動恢復
- [ ] 撤銷家人 token 後其頁面顯示連結已失效
- [ ] 新增航段 BR61（台北 12:00 → 維也納 18:00 當地），回傳 UTC 正確（04:00Z / 16:00Z）
- [ ] 期限落在飛行窗內時排程不警報；降落 3.5 小時後警報，文案含「預計已於 … 降落」
- [ ] 家人頁飛行中顯示藍色狀態卡與航段列表
- [ ] 時間軸卡片顯示城市、經緯度與地圖連結；Nominatim 失敗時退回時區城市名

---

## 14. 已定案事項（原待決）

| # | 項目 | 決定 |
|---|---|---|
| 1 | 警報參數 | `REPEAT_H = 3`、`MAX_ALERTS = 4`；台北 23:00–07:00 為安靜時段，08:00 補發一次；末則註明為最後一次 |
| 2 | 打卡是否推群組 | **不推**，只推狀態變化（起訖、離線、警報、恢復） |
| 3 | 訊息格式 | 位置訊息 + 帶家人頁連結的文字，不用 Flex |
| 4 | 家人頁 | **保留**，含雙時鐘、地圖、時間軸 |
| 5 | 時區顯示 | 家人頁與所有訊息同時顯示台北與旅人當地時間；旅人時區由座標推算 |
| 6 | 航段 | 多筆、當地時間輸入；飛行中不警報，期限順延至降落後 3 小時 |
| 7 | 地點顯示 | 打卡時反向地理編碼存城市；卡片顯示城市 + 經緯度 + 地圖連結 |
| 8 | 照片打卡 | 手動觸發（捷徑分享表單 / 網頁上傳），不自動；群組訊息不附照片 |
| 9 | 多使用者 | `/me` 用 LINE Login，捷徑用 API 金鑰；不做邀請名單、不做每人額度；責任與成本由擁有者承擔 |
