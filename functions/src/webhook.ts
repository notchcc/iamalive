/**
 * LINE webhook：綁定群組、位置訊息打卡、旅行者文字指令、家人免費查詢（reply）。
 *
 * 注意：2nd gen Functions 在回應後 CPU 會被節流，所以事件處理完才回 200。
 * LINE 不會因回應稍慢而重送（預設未開啟 redelivery），事件仍會被處理。
 */
import type { webhook } from '@line/bot-sdk';
import { logger } from 'firebase-functions/v2';
import type { Request, Response } from 'express';
import { TRAVELER_LINE_UID, familyUrl } from './config.js';
import { Timestamp, getLineConfig, lineConfigRef } from './db.js';
import { recentListMessages, reply, textMsg, verifyLineSignature, whereMessages } from './line.js';
import { fmtBoth } from './time.js';
import { HttpError, endTrip, getActiveTrip, recentForTrip, recordCheckin, setOffline, updateLastNote } from './trips.js';

type Event = webhook.Event;

function isTraveler(userId: string | undefined): boolean {
  const uid = TRAVELER_LINE_UID.value();
  return Boolean(uid) && userId === uid;
}

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

async function handleEvent(ev: Event): Promise<void> {
  const cfg = await getLineConfig();
  const gid = groupIdOf(ev);

  if (ev.type === 'join') {
    if (!gid) return;
    if (cfg.groupId && cfg.groupId !== gid) {
      logger.warn('join ignored: already bound to another group', { gid });
      return;
    }
    await lineConfigRef.set({ groupId: gid, joinedAt: Timestamp.now() }, { merge: true });
    const rt = (ev as webhook.JoinEvent).replyToken;
    if (rt) await reply(rt, [textMsg('已加入。之後行程起訖、離線預告與逾時提醒都會在這裡通知。\n輸入「在哪」查最後位置，「行程」看最近回報。')]);
    return;
  }

  if (ev.type === 'leave') {
    if (gid && cfg.groupId === gid) {
      await lineConfigRef.set({ groupId: null, joinedAt: null }, { merge: true });
      logger.warn('bot left the bound group');
    }
    return;
  }

  if (!gid) return;

  // 尚未綁定任何群組時，第一個送來事件的群組視為家人群組（個人用，bot 只會在一個群組）。
  // 涵蓋「邀請 bot 時 webhook 尚未開啟、join 事件遺失」的情況。
  if (!cfg.groupId) {
    await lineConfigRef.set({ groupId: gid, joinedAt: Timestamp.now() }, { merge: true });
    cfg.groupId = gid;
    logger.warn('auto-bound group from first event', { gid, userId: userIdOf(ev), type: ev.type });
  }

  // 其餘事件只處理已綁定群組。
  if (gid !== cfg.groupId) {
    logger.info('event from unbound group ignored', { gid, type: ev.type });
    return;
  }
  if (ev.type !== 'message') return;

  const mev = ev as webhook.MessageEvent;
  const userId = userIdOf(ev);
  const replyToken = mev.replyToken;
  if (!isTraveler(userId)) {
    // 初次設定：從 log 取得自己的 userId 後寫入 Secret TRAVELER_LINE_UID。
    logger.info('message from non-traveler userId', { userId, type: mev.message.type });
  }

  if (mev.message.type === 'location') {
    if (!isTraveler(userId)) return;
    const loc = mev.message as webhook.LocationMessageContent;
    const trip = await getActiveTrip();
    if (!trip) {
      if (replyToken) await reply(replyToken, [textMsg('目前沒有進行中的行程，未記錄。')]);
      return;
    }
    const note = [loc.title, loc.address].filter(Boolean).join(' ').slice(0, 200);
    const r = await recordCheckin(trip, {
      lat: loc.latitude,
      lng: loc.longitude,
      accuracy: null,
      source: 'line',
      note,
      nextHours: null,
      clientAt: new Date(mev.timestamp),
    });
    if (replyToken) {
      const now = new Date();
      await reply(replyToken, [
        textMsg(`已記錄 · ${fmtBoth(now, r.tz)}\n下次期限 ${fmtBoth(r.nextDeadlineAt, r.tz)}${r.recovered ? '\n（已解除逾時警報）' : ''}`),
      ]);
    }
    return;
  }

  if (mev.message.type !== 'text' || !replyToken) return;
  const text = (mev.message as webhook.TextMessageContent).text.trim();

  // 旅行者指令
  if (isTraveler(userId)) {
    const offline = text.match(/^離線\s*(\d{1,3})$/);
    if (offline) {
      const hours = Number(offline[1]);
      if (hours < 1 || hours > 168) {
        await reply(replyToken, [textMsg('離線時數需在 1–168 之間。')]);
        return;
      }
      const trip = await getActiveTrip();
      if (!trip) return void (await reply(replyToken, [textMsg('目前沒有進行中的行程。')]));
      const out = await setOffline(trip, hours);
      await reply(replyToken, [textMsg(`已設定離線至 ${fmtBoth(out.offlineUntil, trip.data().travelerTz)}，期間不會警報。`)]);
      return;
    }
    if (text === '結束') {
      const trip = await getActiveTrip();
      if (!trip) return void (await reply(replyToken, [textMsg('目前沒有進行中的行程。')]));
      await endTrip(trip, '旅行者以 LINE 指令結案');
      return;
    }
    const noteCmd = text.match(/^備註\s+(.+)$/s);
    if (noteCmd) {
      const trip = await getActiveTrip();
      if (!trip) return void (await reply(replyToken, [textMsg('目前沒有進行中的行程。')]));
      const ok = await updateLastNote(trip, noteCmd[1].slice(0, 200));
      await reply(replyToken, [textMsg(ok ? '已補上備註。' : '尚無打卡可補備註。')]);
      return;
    }
  }

  // 任何成員的查詢（reply 免費）
  if (/在哪|平安/.test(text)) {
    const trip = await getActiveTrip();
    if (!trip) return void (await reply(replyToken, [textMsg('目前沒有進行中的行程。')]));
    await reply(replyToken, whereMessages(trip.data(), familyUrl(trip.data().groupReadToken)));
    return;
  }
  if (/行程/.test(text)) {
    const trip = await getActiveTrip();
    if (!trip) return void (await reply(replyToken, [textMsg('目前沒有進行中的行程。')]));
    const recent = await recentForTrip(trip.id, 5);
    await reply(replyToken, recentListMessages(trip.data(), recent, familyUrl(trip.data().groupReadToken)));
    return;
  }
}

export { HttpError };
