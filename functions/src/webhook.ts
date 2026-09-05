/**
 * LINE webhook（多群組版）：
 * - 群組以「綁定 123456」綁到一位擁有者（綁定碼由 /me 產生）。
 * - 其餘事件依 groupId → ownerUid → 該人的進行中行程 路由。
 * - 位置訊息打卡與旅行者指令只接受擁有者本人；「在哪」「行程」任何成員可用（reply 免費）。
 *
 * 注意：2nd gen Functions 在回應後 CPU 會被節流，所以事件處理完才回 200。
 */
import type { webhook } from '@line/bot-sdk';
import { logger } from 'firebase-functions/v2';
import type { Request, Response } from 'express';
import { familyUrl, liffUrl } from './config.js';
import exifr from 'exifr';
import { Timestamp, bindCodesCol, db, groupsCol, pendingPhotosCol } from './db.js';
import { downloadMessageContent, recentListMessages, reply, textMsg, verifyLineSignature, whereMessages } from './line.js';
import { MAX_PHOTO_BYTES, deletePhoto, isAllowedImage, savePhoto } from './photos.js';
import { fmtBoth } from './time.js';
import { attachPhotoToLastCheckin, deleteLatestCheckin, endTrip, getActiveTrip, recentForTrip, recordCheckin, setIntervalHours, setOffline, updateLastNote } from './trips.js';

/** 照片與位置的配對窗。 */
const PAIR_WINDOW_MS = 15 * 60_000;

type Event = webhook.Event;

const HELP_UNBOUND = '此群組尚未綁定。請到管理頁取得 6 位數綁定碼，然後在這裡輸入「綁定 123456」。';

function groupIdOf(ev: Event): string | null {
  const src = ev.source as webhook.Source | undefined;
  return src && src.type === 'group' ? (src as webhook.GroupSource).groupId : null;
}

function userIdOf(ev: Event): string | undefined {
  const src = ev.source as webhook.Source | undefined;
  return src ? (src as { userId?: string }).userId : undefined;
}

export async function handleLineWebhook(req: Request, res: Response): Promise<void> {
  const signature = req.header('x-line-signature');
  const raw = (req as Request & { rawBody?: Buffer }).rawBody ?? Buffer.from(JSON.stringify(req.body ?? {}));
  if (!verifyLineSignature(raw, signature)) {
    res.status(401).send('bad signature');
    return;
  }
  const body = req.body as webhook.CallbackRequest;
  const events: Event[] = body?.events ?? [];
  for (const ev of events) {
    try {
      await handleEvent(ev);
    } catch (err) {
      logger.error('webhook event failed', { type: ev.type, err: String(err) });
    }
  }
  res.status(200).send('ok');
}

/** 以綁定碼把群組綁到擁有者；同一人先前綁的其他群組會解除。 */
export async function bindGroupWithCode(gid: string, code: string, userId: string | undefined): Promise<'ok' | 'invalid' | 'not_owner'> {
  const ref = bindCodesCol.doc(code);
  const snap = await ref.get();
  const bc = snap.data();
  if (!bc || bc.expiresAt.toMillis() < Date.now()) return 'invalid';
  if (!userId || bc.uid !== userId) return 'not_owner';
  const others = await groupsCol.where('ownerUid', '==', bc.uid).get();
  const batch = db.batch();
  for (const d of others.docs) if (d.id !== gid) batch.delete(d.ref);
  batch.set(groupsCol.doc(gid), { ownerUid: bc.uid, boundAt: Timestamp.now() });
  batch.delete(ref);
  await batch.commit();
  return 'ok';
}

const HELP_DM =
  '直接傳送「位置」給我就會記錄一次平安回報；傳照片再傳位置，會記成一筆含照片的打卡。\n' +
  '文字指令：\n' +
  '・離線 16 → 預告接下來 16 小時不會回報\n' +
  '・頻率 6 → 之後改成每 6 小時回報，期限立即重算\n' +
  '・結束 → 結束目前行程\n' +
  '・備註 已到飯店 → 補到最後一筆打卡\n' +
  '・刪除最後一筆 → 刪掉最新一筆打卡（含照片）\n' +
  '・在哪 / 行程 → 查看最後位置與最近回報\n' +
  '行程的建立與家人群組綁定請到管理頁。';

function helpDm(): string {
  const u = liffUrl();
  return u ? `${HELP_DM}\n管理頁：${u}` : HELP_DM;
}

/** 取出並消耗這位使用者待配對的照片（若未過期且屬於同一行程）。 */
async function takePendingPhoto(uid: string, tripId: string): Promise<{ photoId: string; takenAt: Date | null } | null> {
  const ref = pendingPhotosCol.doc(uid);
  const snap = await ref.get();
  const p = snap.data();
  if (!p) return null;
  await ref.delete();
  if (p.tripId !== tripId || p.expiresAt.toMillis() < Date.now()) {
    await deletePhoto(p.tripId, p.photoId);
    return null;
  }
  return { photoId: p.photoId, takenAt: p.takenAt ? p.takenAt.toDate() : null };
}

/** 擁有者的位置訊息 → 打卡並回覆；若有待配對的照片就一併附上。 */
async function handleOwnerLocation(ownerUid: string, mev: webhook.MessageEvent): Promise<void> {
  const loc = mev.message as webhook.LocationMessageContent;
  const replyToken = mev.replyToken;
  const trip = await getActiveTrip(ownerUid);
  if (!trip) {
    if (replyToken) await reply(replyToken, [textMsg('目前沒有進行中的行程，未記錄。請先到管理頁建立行程。')]);
    return;
  }
  const pending = await takePendingPhoto(ownerUid, trip.id);
  const note = [loc.title, loc.address].filter(Boolean).join(' ').slice(0, 200);
  const r = await recordCheckin(trip, {
    lat: loc.latitude,
    lng: loc.longitude,
    accuracy: null,
    source: pending ? 'photo' : 'line',
    note,
    nextHours: null,
    clientAt: new Date(mev.timestamp),
    photoId: pending?.photoId ?? null,
    takenAt: pending?.takenAt ?? null,
  });
  if (replyToken) {
    const now = new Date();
    await reply(replyToken, [
      textMsg(
        `${pending ? '📷 ' : ''}已記錄 · ${fmtBoth(now, r.tz)}\n下次期限 ${fmtBoth(r.nextDeadlineAt, r.tz)}${r.recovered ? '\n（已解除逾時警報）' : ''}`,
      ),
    ]);
  }
}

/**
 * 擁有者的圖片訊息：
 * 1. 圖片帶 GPS → 直接照片打卡。
 * 2. 15 分鐘內剛打過卡且沒照片 → 附上去。
 * 3. 否則暫存 15 分鐘，等位置訊息來配對。
 */
async function handleOwnerImage(ownerUid: string, mev: webhook.MessageEvent): Promise<void> {
  const replyToken = mev.replyToken;
  const trip = await getActiveTrip(ownerUid);
  if (!trip) {
    if (replyToken) await reply(replyToken, [textMsg('目前沒有進行中的行程，照片未記錄。')]);
    return;
  }
  const content = await downloadMessageContent(mev.message.id, MAX_PHOTO_BYTES);
  if (!content || !isAllowedImage(content.contentType)) {
    if (replyToken) await reply(replyToken, [textMsg('照片無法讀取或過大（上限 8 MB）。')]);
    return;
  }
  let gps: { latitude: number; longitude: number } | null = null;
  let takenAt: Date | null = null;
  try {
    const g = await exifr.gps(content.data);
    if (g && Number.isFinite(g.latitude) && Number.isFinite(g.longitude)) gps = g;
    const t = (await exifr.parse(content.data, { pick: ['DateTimeOriginal'] })) as { DateTimeOriginal?: Date } | undefined;
    if (t?.DateTimeOriginal instanceof Date) takenAt = t.DateTimeOriginal;
  } catch {
    /* 無 EXIF */
  }
  const photoId = await savePhoto(trip.id, content.data, content.contentType);

  if (gps) {
    const r = await recordCheckin(trip, {
      lat: gps.latitude,
      lng: gps.longitude,
      accuracy: null,
      source: 'photo',
      note: '',
      nextHours: null,
      clientAt: new Date(mev.timestamp),
      photoId,
      takenAt,
    });
    if (replyToken) await reply(replyToken, [textMsg(`📷 已用照片位置打卡 · ${fmtBoth(new Date(), r.tz)}\n下次期限 ${fmtBoth(r.nextDeadlineAt, r.tz)}`)]);
    return;
  }

  if (await attachPhotoToLastCheckin(trip, photoId, takenAt, PAIR_WINDOW_MS)) {
    if (replyToken) await reply(replyToken, [textMsg('📷 已把照片附到剛才那筆打卡。')]);
    return;
  }

  // 暫存，覆蓋舊的待配對照片
  const old = (await pendingPhotosCol.doc(ownerUid).get()).data();
  if (old) await deletePhoto(old.tripId, old.photoId);
  await pendingPhotosCol.doc(ownerUid).set({
    tripId: trip.id,
    photoId,
    takenAt: takenAt ? Timestamp.fromDate(takenAt) : null,
    createdAt: Timestamp.now(),
    expiresAt: Timestamp.fromMillis(Date.now() + PAIR_WINDOW_MS),
  });
  if (replyToken) await reply(replyToken, [textMsg('📷 已收到照片（LINE 傳送的圖片沒有位置資訊）。\n請在 15 分鐘內傳送「位置」，我會合成一筆含照片的打卡。')]);
}

/** 擁有者文字指令。回傳 true 表示已處理。 */
async function handleOwnerCommand(ownerUid: string, text: string, replyToken: string): Promise<boolean> {
  const offline = text.match(/^離線\s*(\d{1,3})$/);
  if (offline) {
    const hours = Number(offline[1]);
    if (hours < 1 || hours > 168) {
      await reply(replyToken, [textMsg('離線時數需在 1–168 之間。')]);
      return true;
    }
    const trip = await getActiveTrip(ownerUid);
    if (!trip) {
      await reply(replyToken, [textMsg('目前沒有進行中的行程。')]);
      return true;
    }
    const out = await setOffline(trip, hours);
    await reply(replyToken, [textMsg(`已設定離線至 ${fmtBoth(out.offlineUntil, trip.data().travelerTz)}，期間不會警報。`)]);
    return true;
  }
  const freq = text.match(/^頻率\s*(\d{1,2})$/);
  if (freq) {
    const hours = Number(freq[1]);
    if (hours < 1 || hours > 72) {
      await reply(replyToken, [textMsg('打卡頻率需在 1–72 小時之間。')]);
      return true;
    }
    const trip = await getActiveTrip(ownerUid);
    if (!trip) {
      await reply(replyToken, [textMsg('目前沒有進行中的行程。')]);
      return true;
    }
    const out = await setIntervalHours(trip, hours);
    await reply(replyToken, [textMsg(`已改為每 ${hours} 小時回報，下次期限 ${fmtBoth(out.nextDeadlineAt, trip.data().travelerTz)}。`)]);
    return true;
  }
  if (/^刪除(最後|上)一筆$/.test(text)) {
    const trip = await getActiveTrip(ownerUid);
    if (!trip) {
      await reply(replyToken, [textMsg('目前沒有進行中的行程。')]);
      return true;
    }
    const gone = await deleteLatestCheckin(trip);
    if (!gone) {
      await reply(replyToken, [textMsg('沒有可刪除的打卡。')]);
      return true;
    }
    const where = gone.place ? `${gone.place} · ` : '';
    await reply(replyToken, [textMsg(`🗑 已刪除 ${where}${fmtBoth(gone.at.toDate(), gone.tz)} 的打卡${gone.photoId ? '（含照片）' : ''}${gone.note ? `「${gone.note}」` : ''}。下次期限不變。`)]);
    return true;
  }
  if (text === '結束') {
    const trip = await getActiveTrip(ownerUid);
    if (!trip) {
      await reply(replyToken, [textMsg('目前沒有進行中的行程。')]);
      return true;
    }
    await endTrip(trip, '旅行者以 LINE 指令結案');
    await reply(replyToken, [textMsg('行程已結束。')]);
    return true;
  }
  const noteCmd = text.match(/^備註\s+(.+)$/s);
  if (noteCmd) {
    const trip = await getActiveTrip(ownerUid);
    if (!trip) {
      await reply(replyToken, [textMsg('目前沒有進行中的行程。')]);
      return true;
    }
    const ok = await updateLastNote(trip, noteCmd[1].slice(0, 200));
    await reply(replyToken, [textMsg(ok ? '已補上備註。' : '尚無打卡可補備註。')]);
    return true;
  }
  return false;
}

/** 任何人都能用的查詢。回傳 true 表示已處理。 */
async function handleQuery(ownerUid: string, text: string, replyToken: string): Promise<boolean> {
  if (/在哪|平安/.test(text)) {
    const trip = await getActiveTrip(ownerUid);
    if (!trip) await reply(replyToken, [textMsg('目前沒有進行中的行程。')]);
    else await reply(replyToken, whereMessages(trip.data(), familyUrl(trip.data().groupReadToken)));
    return true;
  }
  if (/行程/.test(text)) {
    const trip = await getActiveTrip(ownerUid);
    if (!trip) await reply(replyToken, [textMsg('目前沒有進行中的行程。')]);
    else await reply(replyToken, recentListMessages(trip.data(), await recentForTrip(trip.id, 5), familyUrl(trip.data().groupReadToken)));
    return true;
  }
  return false;
}

/** 1 對 1 聊天：傳訊者本人就是擁有者。 */
async function handleDirectEvent(ev: Event, userId: string): Promise<void> {
  if (ev.type === 'follow') {
    const rt = (ev as webhook.FollowEvent).replyToken;
    if (rt) await reply(rt, [textMsg(`感謝加入 iamalive。\n${helpDm()}`)]);
    return;
  }
  if (ev.type !== 'message') return;
  const mev = ev as webhook.MessageEvent;
  if (mev.message.type === 'location') {
    await handleOwnerLocation(userId, mev);
    return;
  }
  if (mev.message.type === 'image') {
    await handleOwnerImage(userId, mev);
    return;
  }
  if (mev.message.type !== 'text' || !mev.replyToken) return;
  const text = (mev.message as webhook.TextMessageContent).text.trim();
  if (await handleOwnerCommand(userId, text, mev.replyToken)) return;
  if (await handleQuery(userId, text, mev.replyToken)) return;
  await reply(mev.replyToken, [textMsg(helpDm())]);
}

async function handleEvent(ev: Event): Promise<void> {
  const gid = groupIdOf(ev);
  if (!gid) {
    const src = ev.source as webhook.Source | undefined;
    const uid = userIdOf(ev);
    if (src?.type === 'user' && uid) await handleDirectEvent(ev, uid);
    return;
  }

  if (ev.type === 'join') {
    const rt = (ev as webhook.JoinEvent).replyToken;
    const bound = await groupsCol.doc(gid).get();
    if (rt) {
      await reply(rt, [
        textMsg(
          bound.exists
            ? '已回到群組。行程起訖、離線預告與逾時提醒會在這裡通知。'
            : `已加入。${HELP_UNBOUND}\n綁定後：行程起訖、離線預告與逾時提醒會在這裡通知；輸入「在哪」查最後位置，「行程」看最近回報。`,
        ),
      ]);
    }
    return;
  }

  if (ev.type === 'leave') {
    await groupsCol.doc(gid).delete().catch(() => undefined);
    logger.warn('bot left group; binding removed', { gid });
    return;
  }

  if (ev.type !== 'message') return;
  const mev = ev as webhook.MessageEvent;
  const userId = userIdOf(ev);
  const replyToken = mev.replyToken;

  // 綁定指令（任何群組都處理）
  if (mev.message.type === 'text') {
    const m = (mev.message as webhook.TextMessageContent).text.trim().match(/^綁定\s*(\d{6})$/);
    if (m) {
      const r = await bindGroupWithCode(gid, m[1], userId);
      if (replyToken) {
        await reply(replyToken, [
          textMsg(
            r === 'ok'
              ? '✅ 綁定完成。之後行程起訖、離線預告與逾時提醒會在這裡通知。'
              : r === 'not_owner'
                ? '這組綁定碼不是你的，請由產生綁定碼的本人輸入。'
                : '綁定碼無效或已過期（10 分鐘），請到管理頁重新產生。',
          ),
        ]);
      }
      return;
    }
  }

  const binding = (await groupsCol.doc(gid).get()).data();
  if (!binding) {
    // 未綁定群組：只在有人試著用指令時提示，其餘靜默
    if (mev.message.type === 'text' && replyToken) {
      const t = (mev.message as webhook.TextMessageContent).text;
      if (/在哪|平安|行程|離線|頻率|結束|備註/.test(t)) await reply(replyToken, [textMsg(HELP_UNBOUND)]);
    }
    return;
  }
  const ownerUid = binding.ownerUid;
  const isOwner = userId === ownerUid;

  if (mev.message.type === 'location') {
    if (!isOwner) return;
    await handleOwnerLocation(ownerUid, mev);
    return;
  }
  if (mev.message.type === 'image') {
    if (isOwner) await handleOwnerImage(ownerUid, mev);
    return;
  }

  if (mev.message.type !== 'text' || !replyToken) return;
  const text = (mev.message as webhook.TextMessageContent).text.trim();
  if (isOwner && (await handleOwnerCommand(ownerUid, text, replyToken))) return;
  await handleQuery(ownerUid, text, replyToken);
}
