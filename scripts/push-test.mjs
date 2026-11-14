// Manual test: sends one notification to every subscriber. Run from the "Push test" workflow.
import { readFile } from 'node:fs/promises';
const cfg = JSON.parse(await readFile('push-config.json', 'utf8'));
if (!process.env.ONESIGNAL_API_KEY) { console.log('ONESIGNAL_API_KEY secret is missing'); process.exit(1); }
const r = await fetch('https://api.onesignal.com/notifications?c=push', {
  method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Key ' + process.env.ONESIGNAL_API_KEY },
  body: JSON.stringify({ app_id: cfg.appId, included_segments: ['Total Subscriptions'], target_channel: 'push',
    headings: { en: '✅ Trader Holic', ar: '✅ Trader Holic' },
    contents: { en: process.env.MSG || 'التنبيهات شغّالة! بيوصلك إشعار قبل كل خبر قوي بـ 15 دقيقة، وإشعار بالنتيجة وتأثيرها.', ar: process.env.MSG || 'التنبيهات شغّالة! بيوصلك إشعار قبل كل خبر قوي بـ 15 دقيقة، وإشعار بالنتيجة وتأثيرها.' },
    url: 'https://traderholic.github.io/#calendar', chrome_web_icon: 'https://traderholic.github.io/icons/icon-192.png' })
});
const t = await r.text(); console.log(r.status, t);
if (!r.ok) process.exit(1);
