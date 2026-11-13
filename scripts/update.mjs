// Trader Holic — data refresher (runs on GitHub Actions every 15 minutes).
// Writes data/calendar.json (economic calendar) and data/news.json (latest headlines).
import { readFile, writeFile, mkdir } from 'node:fs/promises';

const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';
async function get(url) {
  const ctl = AbortSignal.timeout(25000);
  const r = await fetch(url, { headers: { 'user-agent': UA, accept: '*/*' }, signal: ctl, redirect: 'follow' });
  if (!r.ok) throw new Error(`${r.status} ${url}`);
  return r.text();
}
async function readJson(path) { try { return JSON.parse(await readFile(path, 'utf8')); } catch { return null; } }
async function writeIfChanged(path, obj, ignoreKey = 'updated') {
  const old = await readJson(path);
  const strip = o => { if (!o) return ''; const c = { ...o }; delete c[ignoreKey]; return JSON.stringify(c); };
  if (strip(old) === strip(obj)) { console.log('unchanged', path); return false; }
  await writeFile(path, JSON.stringify(obj));
  console.log('wrote', path);
  return true;
}

/* ---------------- Economic calendar (ForexFactory weekly export) ---------------- */
const CURRENCIES = new Set(['USD', 'EUR', 'GBP', 'CNY', 'JPY', 'All']);
async function calendar() {
  const path = 'data/calendar.json';
  const old = await readJson(path);
  // The export is rate-limited: refresh at most about once an hour.
  if (old?.updated && Date.now() - Date.parse(old.updated) < 50 * 60 * 1000) { console.log('calendar fresh, skip'); return; }
  const events = [];
  for (const wk of ['thisweek', 'nextweek']) {
    try {
      const arr = JSON.parse(await get(`https://nfs.faireconomy.media/ff_calendar_${wk}.json`));
      for (const e of arr) {
        if (!e?.date || !e?.title || !CURRENCIES.has(e.country)) continue;
        const t = Date.parse(e.date); if (Number.isNaN(t)) continue;
        events.push({ t: e.title.trim(), c: e.country, d: new Date(t).toISOString(), i: e.impact || 'Low', f: (e.forecast || '').trim(), p: (e.previous || '').trim() });
      }
    } catch (err) { console.log('calendar', wk, String(err.message || err)); }
  }
  if (!events.length) { console.log('calendar: no events fetched, keeping old file'); return; }
  const seen = new Set();
  const uniq = events.filter(e => { const k = e.d + e.c + e.t; if (seen.has(k)) return false; seen.add(k); return true; }).sort((a, b) => a.d.localeCompare(b.d));
  // Keep earlier events of the current view if the new fetch lost them (e.g. week rollover).
  await writeFile(path, JSON.stringify({ updated: new Date().toISOString(), source: 'ForexFactory', events: uniq }));
  console.log('calendar events', uniq.length);
}

/* ---------------- News (RSS) ---------------- */
const dec = s => s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').replace(/<[^>]+>/g, '')
  .replace(/&#(\d+);/g, (m, n) => String.fromCodePoint(+n)).replace(/&#x([0-9a-f]+);/gi, (m, n) => String.fromCodePoint(parseInt(n, 16)))
  .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
const tag = (xml, name) => { const m = xml.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`, 'i')); return m ? dec(m[1]) : ''; };
function parseRss(xml, fallbackSource) {
  const out = [];
  for (const m of xml.matchAll(/<item[\s>]([\s\S]*?)<\/item>/gi)) {
    const it = m[1];
    let title = tag(it, 'title'); const link = tag(it, 'link'); const date = Date.parse(tag(it, 'pubDate') || tag(it, 'dc:date'));
    let source = tag(it, 'source') || fallbackSource || '';
    if (!title || !/^https?:\/\//.test(link) || Number.isNaN(date)) continue;
    if (source && title.endsWith(' - ' + source)) title = title.slice(0, -(source.length + 3)).trim();
    out.push({ t: title, u: link, s: source, d: new Date(date).toISOString() });
  }
  return out;
}
const gnews = q => `https://news.google.com/rss/search?q=${encodeURIComponent(q)}&hl=ar&gl=SA&ceid=SA%3Aar`;
const FEEDS = {
  gold: {
    primary: [gnews('(الذهب OR الفضة) (أوقية OR الأوقية OR الأونصة OR "المعدن الأصفر" OR الفيدرالي OR الدولار OR "المعدن النفيس" OR "الملاذ الآمن") when:2d')],
    exclude: /عيار|جنيه|جنيها|ريال|درهم|دينار|ليرة|الليرة|بالأسواق المحلية|محلات|الصاغة|المصوغات|سبيكة|سبائك|الجرام|للجرام|بالجرام/,
    fallback: [{ url: 'https://www.fxstreet.com/rss/news', source: 'FXStreet', filter: /gold|xau|silver|xag/i }]
  },
  crypto: {
    primary: [gnews('(بتكوين OR البيتكوين OR "العملات الرقمية" OR "العملات المشفرة" OR إيثريوم) when:2d')],
    fallback: [{ url: 'https://cointelegraph.com/rss', source: 'Cointelegraph' }]
  },
  markets: {
    primary: [gnews('("الفيدرالي الأمريكي" OR "وول ستريت" OR "الأسهم الأمريكية" OR "التضخم الأمريكي" OR "الفائدة الأمريكية" OR "مؤشر الدولار") when:2d')],
    fallback: [{ url: 'https://www.cnbc.com/id/100003114/device/rss/rss.html', source: 'CNBC' }]
  }
};
async function news() {
  const path = 'data/news.json';
  const old = (await readJson(path)) || {};
  const out = { updated: new Date().toISOString() };
  const cutoff = Date.now() - 72 * 3600 * 1000;
  for (const [key, cfg] of Object.entries(FEEDS)) {
    let items = [];
    for (const url of cfg.primary) { try { items.push(...parseRss(await get(url))); } catch (e) { console.log('news', key, String(e.message || e)); } }
    if (items.length < 6) {
      for (const f of cfg.fallback) {
        try { let more = parseRss(await get(f.url), f.source); if (f.filter) more = more.filter(x => f.filter.test(x.t)); items.push(...more); }
        catch (e) { console.log('news fallback', key, String(e.message || e)); }
      }
    }
    if (cfg.exclude) items = items.filter(x => !cfg.exclude.test(x.t));
    items.forEach(x => { x.s = (x.s || '').replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/$/, ''); });
    const seen = new Set();
    items = items.filter(x => Date.parse(x.d) >= cutoff && Date.parse(x.d) <= Date.now() + 600000)
      .sort((a, b) => b.d.localeCompare(a.d))
      .filter(x => { const k = x.t.replace(/[^\p{L}\p{N}]/gu, '').slice(0, 60); if (seen.has(k)) return false; seen.add(k); return true; })
      .slice(0, 30);
    out[key] = items.length ? items : (old[key] || []);
    console.log('news', key, items.length);
  }
  await writeIfChanged(path, out);
}

await mkdir('data', { recursive: true });
await calendar().catch(e => console.log('calendar failed', e));
await news().catch(e => console.log('news failed', e));
