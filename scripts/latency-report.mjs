// Manual check: how long after each release did its actual figure reach the site?
// Usage: node scripts/latency-report.mjs [hoursBack=30]
// Walks the git history of data/calendar.json and reports, per released event,
// the first commit in which its actual ("a") appears.
import { execSync } from 'node:child_process';
const hours = Number(process.argv[2]) || 30;
const sh = c => execSync(c, { maxBuffer: 1 << 28 }).toString();
const commits = sh(`git log --since="${hours} hours ago" --reverse --format="%H %cI" -- data/calendar.json`).trim().split('\n').filter(Boolean)
  .map(l => { const [h, t] = l.split(' '); return { h, t: Date.parse(t) }; });
const first = new Map();
let last = null;
for (const c of commits) {
  let j; try { j = JSON.parse(sh(`git show ${c.h}:data/calendar.json`)); } catch { continue; }
  last = j;
  for (const e of j.events || []) { const k = e.d + '|' + e.c + '|' + e.t; if (e.a && !first.has(k)) first.set(k, { at: c.t, a: e.a }); }
}
const now = Date.now(), from = now - hours * 3600000;
const kw = t => new Date(t + 3 * 3600000).toISOString().slice(5, 16).replace('T', ' ');
const rows = [];
for (const e of (last?.events || [])) {
  const t = Date.parse(e.d); if (t < from || t > now || e.i === 'Holiday') continue;
  if (/Speaks|Testif|Press Conference|Statement|Minutes|Meeting|Speech|Hearing|Auction/i.test(e.t)) continue;
  const k = e.d + '|' + e.c + '|' + e.t, f = first.get(k);
  rows.push({ when: kw(t), imp: e.i, ev: `${e.c} ${e.t}`, f: e.f, a: f?.a ?? '—', delay: f ? Math.round((f.at - t) / 6000) / 10 + ' min' : 'MISSING' });
}
console.log(`Kuwait time | impact | event | forecast | actual | delay to commit (Pages adds ~1 min)`);
for (const r of rows) console.log(`${r.when} | ${r.imp} | ${r.ev} | ${r.f} | ${r.a} | ${r.delay}`);
const hm = rows.filter(r => r.imp !== 'Low');
console.log(`\nHigh/Medium: ${hm.length}, missing: ${hm.filter(r => r.delay === 'MISSING').length}, max delay: ${Math.max(0, ...hm.filter(r => r.delay !== 'MISSING').map(r => parseFloat(r.delay)))} min`);
