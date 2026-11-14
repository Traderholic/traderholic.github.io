// Sends one notification to every subscriber. Triggered by a change to push-message.json
// ({"title": "...", "body": "...", "url": "optional"}), or manually from the "Push test" workflow.
import { readFile } from 'node:fs/promises';
const cfg = JSON.parse(await readFile('push-config.json', 'utf8'));
if (!process.env.ONESIGNAL_API_KEY) { console.log('ONESIGNAL_API_KEY secret is missing'); process.exit(1); }
let msg = {};
try { msg = JSON.parse(await readFile('push-message.json', 'utf8')); } catch { /* none */ }
const title = msg.title || 'Trader Holic';
const body = process.env.MSG || msg.body || 'التنبيهات شغّالة!';
const r = await fetch('https://api.onesignal.com/notifications?c=push', {
  method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Key ' + process.env.ONESIGNAL_API_KEY },
  body: JSON.stringify({ app_id: cfg.appId, included_segments: ['Total Subscriptions'], target_channel: 'push',
    headings: { en: title, ar: title }, contents: { en: body, ar: body },
    url: msg.url || 'https://traderholic.github.io/', chrome_web_icon: 'https://traderholic.github.io/icons/icon-192.png' })
});
const t = await r.text(); console.log(r.status, t);
if (!r.ok) process.exit(1);
