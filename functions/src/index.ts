import { setGlobalOptions } from 'firebase-functions/v2';
import { onRequest } from 'firebase-functions/v2/https';
import { onSchedule } from 'firebase-functions/v2/scheduler';
import { logger } from 'firebase-functions/v2';
import { createApp } from './api.js';
import { ALL_SECRETS, LINE_SECRETS, REGION, WRITE_TOKEN } from './config.js';
import { runOverdueScan } from './overdue.js';
import { TAIPEI } from './time.js';
import { handleLineWebhook } from './webhook.js';

setGlobalOptions({ region: REGION, maxInstances: 3, timeoutSeconds: 60, memory: '256MiB' });

const app = createApp();

/** `/api/**`（經 Hosting rewrite）。 */
export const api = onRequest({ secrets: [WRITE_TOKEN, ...LINE_SECRETS] }, app);

/** LINE webhook。直接使用 Functions URL，不經 Hosting rewrite，以保留 rawBody 驗簽。 */
export const lineWebhook = onRequest({ secrets: LINE_SECRETS }, (req, res) => {
  void handleLineWebhook(req, res);
});

/** 每 15 分鐘掃描逾時。timeZone 指定台北，安靜時段判定亦以台北為準。 */
export const checkOverdue = onSchedule(
  { schedule: 'every 15 minutes', timeZone: TAIPEI, secrets: ALL_SECRETS },
  async () => {
    const r = await runOverdueScan();
    logger.info('checkOverdue done', r);
  },
);
