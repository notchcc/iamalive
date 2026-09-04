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
import { familyUrl } from './config.js';
import { Timestamp, bindCodesCol, db, groupsCol } from './db.js';
import { recentListMessages, reply, textMsg, verifyLineSignature, whereMessages } from './line.js';
import { fmtBoth } from './time.js';
import { endTrip, getActiveTrip, recentForTrip, recordCheckin, setOffline, updateLastNote } from './trips.js';

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

async function handleEvent(ev: Event): Promise<void> {
  const gid = groupIdOf(ev);
  if (!gid) return; // 只服務群組

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
      if (/在哪|平安|行程|離線|結束|備註/.test(t)) await reply(replyToken, [textMsg(HELP_UNBOUND)]);
    }
    return;
  }
  const ownerUid = binding.ownerUid;
  const isOwner = userId === ownerUid;

  if (mev.message.type === 'location') {
    if (!isOwner) return;
    const loc = mev.message as webhook.LocationMessageContent;
    const trip = await getActiveTrip(ownerUid);
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

  if (isOwner) {
    const offline = text.match(/^離線\s*(\d{1,3})$/);
    if (offline) {
      const hours = Number(offline[1]);
      if (hours < 1 || hours > 168) return void (await reply(replyToken, [textMsg('離線時數需在 1–168 之間。')]));
      const trip = await getActiveTrip(ownerUid);
      if (!trip) return void (await reply(replyToken, [textMsg('目前沒有進行中的行程。')]));
      const out = await setOffline(trip, hours);
      await reply(replyToken, [textMsg(`已設定離線至 ${fmtBoth(out.offlineUntil, trip.data().travelerTz)}，期間不會警報。`)]);
      return;
    }
    if (text === '結束') {
      const trip = await getActiveTrip(ownerUid);
      if (!trip) return void (await reply(replyToken, [textMsg('目前沒有進行中的行程。')]));
      await endTrip(trip, '旅行者以 LINE 指令結案');
      return;
    }
    const noteCmd = text.match(/^備註\s+(.+)$/s);
    if (noteCmd) {
      const trip = await getActiveTrip(ownerUid);
      if (!trip) return void (await reply(replyToken, [textMsg('目前沒有進行中的行程。')]));
      const ok = await updateLastNote(trip, noteCmd[1].slice(0, 200));
      await reply(replyToken, [textMsg(ok ? '已補上備註。' : '尚無打卡可補備註。')]);
      return;
    }
  }

  if (/在哪|平安/.test(text)) {
    const trip = await getActiveTrip(ownerUid);
    if (!trip) return void (await reply(replyToken, [textMsg('目前沒有進行中的行程。')]));
    await reply(replyToken, whereMessages(trip.data(), familyUrl(trip.data().groupReadToken)));
    return;
  }
  if (/行程/.test(text)) {
    const trip = await getActiveTrip(ownerUid);
    if (!trip) return void (await reply(replyToken, [textMsg('目前沒有進行中的行程。')]));
    const recent = await recentForTrip(trip.id, 5);
    await reply(replyToken, recentListMessages(trip.data(), recent, familyUrl(trip.data().groupReadToken)));
  }
}
