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

/* ---------------- Economic calendar ----------------
   Schedule, forecast and previous: ForexFactory weekly export (refreshed about hourly, it is rate-limited).
   Actual results: TradingView's public economic calendar, checked on every run while a released event still lacks one. */
const CURRENCIES = new Set(['USD', 'EUR', 'GBP', 'CNY', 'JPY', 'All']);
const keyOf = e => e.d + '|' + e.c + '|' + e.t;
async function fetchFF() {
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
  const seen = new Set();
  return events.filter(e => { const k = keyOf(e); if (seen.has(k)) return false; seen.add(k); return true; }).sort((a, b) => a.d.localeCompare(b.d));
}

// --- matching a ForexFactory title to a TradingView event ---
const REGION = { German: 'DE', French: 'FR', Italian: 'IT', Spanish: 'ES' };
const DEF_REGION = { USD: 'US', EUR: 'EU', GBP: 'GB', JPY: 'JP', CNY: 'CN' };
const SYN = [
  [/adp non-farm employment change|adp employment change/g, ' adp '],
  [/non-farm employment change|non ?farm payrolls|nonfarm payrolls/g, ' nfp '],
  [/unemployment claims|initial jobless claims/g, ' claims '],
  [/continuing jobless claims|continuing claims/g, ' contclaims '],
  [/inflation rate|consumer price index|\bcpi\b/g, ' cpi '],
  [/producer price index|\bppi\b/g, ' ppi '],
  [/federal funds rate|fed interest rate decision|interest rate decision|official bank rate|main refinancing rate|policy rate|bank rate/g, ' ratedecision '],
  [/gdp growth rate|\bgdp\b/g, ' gdp '],
  [/\bprel\b|\bprelim\b|\bflash\b|preliminary/g, ' prelim '],
  [/\badv\b|advance/g, ' advance '],
  [/retail sales ex autos/g, ' core retail sales '],
  [/\bm\/m\b|\bmom\b/g, ' mom '], [/\by\/y\b|\byoy\b/g, ' yoy '], [/\bq\/q\b|\bqoq\b/g, ' qoq '],
  [/jolts job openings|jolts/g, ' jolts '],
  [/s&p global|\bhcob\b|\bau jibun bank\b|\bthe\b|\bs\.a\b|\bindex\b|\bchange\b/g, ' ']
];
function toks(title) {
  let s = ' ' + title.toLowerCase().replace(/^(german|french|italian|spanish)\s+/, '') + ' ';
  for (const [re, r] of SYN) s = s.replace(re, r);
  return new Set(s.replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter(Boolean));
}
const isCore = s => /\bcore\b|ex food|ex autos|excl/i.test(s);
const period = t => (t.has('mom') ? 'mom' : t.has('yoy') ? 'yoy' : t.has('qoq') ? 'qoq' : '');
const num = s => { const m = String(s ?? '').replace(/,/g, '').match(/-?\d+(\.\d+)?/); return m ? parseFloat(m[0]) : null; };
const near = (a, b) => a != null && b != null && Math.abs(a - b) <= Math.max(0.051, Math.abs(a) * 0.006);
function fmtActual(v, ff, tv) {
  const ref = ff.p || ff.f || '';
  const refN = num(ff.f) ?? num(ff.p);
  const suffix = ref ? (ref.match(/[%KMBT]$/i)?.[0] || '') : (tv.unit === '%' ? '%' : (tv.scale || ''));
  let x = v;
  // Counts can come in different units (e.g. 19750 vs 19.8K): rescale by powers of 1000, never for percentages.
  if (refN != null && refN !== 0 && x !== 0 && suffix !== '%') {
    let bestK = 1, bestD = Infinity;
    for (const k of [1, 1000, 0.001, 1e6, 1e-6]) { const d = Math.abs(Math.log10(Math.abs(x * k) / Math.abs(refN))); if (d < bestD) { bestD = d; bestK = k; } }
    x = x * bestK;
  }
  // Sanity: a result wildly off the forecast/previous scale is a bad match, so drop it.
  if (refN != null && Math.abs(x) > 25 * Math.max(Math.abs(refN), 1)) return null;
  const dm = ref.match(/\.(\d+)/); const dec = dm ? dm[1].length : (Number.isInteger(x) ? 0 : Math.min(3, String(x).split('.')[1]?.length || 0));
  return x.toFixed(dec) + suffix;
}
function matchTV(ff, tvList, used) {
  const region = REGION[ff.t.split(' ')[0]] || DEF_REGION[ff.c];
  const ft = toks(ff.t), fc = isCore(ff.t), fper = period(ft), ts = Date.parse(ff.d);
  let best = null;
  for (const tv of tvList) {
    if (used.has(tv.id) || tv.actual == null || tv.currency !== ff.c) continue;
    if (region && tv.country !== region) continue;
    if (Math.abs(Date.parse(tv.date) - ts) > 10 * 60000) continue;
    const tt = toks(tv.title);
    if (isCore(tv.title) !== fc) continue;
    const tper = period(tt); if (fper && tper && fper !== tper) continue;
    const prevOk0 = near(num(ff.p), tv.previous);
    if (fper && !tper && !prevOk0) continue;
    const P = new Set(['mom', 'yoy', 'qoq']);
    const fa = [...ft].filter(w => !P.has(w)), ta = [...tt].filter(w => !P.has(w));
    const inter = fa.filter(w => ta.includes(w)).length;
    const tok = inter / (new Set([...fa, ...ta]).size || 1);
    const prevOk = near(num(ff.p), tv.previous), fcOk = near(num(ff.f), tv.forecast);
    if (!(tok >= 0.5 || (prevOk && tok >= 0.2) || (prevOk && fcOk && tok > 0))) continue;
    const score = tok + (prevOk ? 1 : 0) + (fcOk ? 0.5 : 0);
    if (!best || score > best.score) best = { tv, score };
  }
  return best?.tv || null;
}
async function fetchTV(fromMs, toMs) {
  const url = `https://economic-calendar.tradingview.com/events?from=${new Date(fromMs).toISOString()}&to=${new Date(toMs).toISOString()}&countries=US,EU,DE,FR,IT,ES,GB,JP,CN`;
  const r = await fetch(url, { headers: { 'user-agent': UA, origin: 'https://www.tradingview.com', referer: 'https://www.tradingview.com/' }, signal: AbortSignal.timeout(25000) });
  if (!r.ok) throw new Error('tv ' + r.status);
  const j = await r.json();
  return Array.isArray(j?.result) ? j.result : [];
}

async function calendar() {
  const path = 'data/calendar.json';
  const old = (await readJson(path)) || {};
  const ffAt = old.ffAt || old.updated;
  let events = old.events || [];
  let ffFresh = ffAt;
  if (!ffAt || Date.now() - Date.parse(ffAt) >= 50 * 60 * 1000 || !events.length) {
    const fresh = await fetchFF();
    if (fresh.length) {
      const prevA = new Map(events.filter(e => e.a).map(e => [keyOf(e), e.a]));
      fresh.forEach(e => { const a = prevA.get(keyOf(e)); if (a) e.a = a; });
      events = fresh; ffFresh = new Date().toISOString();
    } else console.log('calendar: FF fetch empty, keeping old schedule');
  } else console.log('calendar: FF fresh, only checking actuals');
  if (!events.length) return;

  // Actual results for released events (last 3 days) that still lack one.
  const now = Date.now();
  const need = events.filter(e => !e.a && e.i !== 'Holiday' && !/Speaks|Testif|Press Conference|Statement|Minutes|Meeting|Speech|Hearing|Auction|Bank Holiday/i.test(e.t)
    && Date.parse(e.d) <= now - 60000 && Date.parse(e.d) >= now - 3 * 86400000);
  if (need.length) {
    try {
      const tv = await fetchTV(now - 3 * 86400000 - 3600000, now + 3600000);
      const used = new Set(); let n = 0;
      for (const e of need) { const m = matchTV(e, tv, used); const a = m && fmtActual(m.actual, e, m); if (a) { used.add(m.id); e.a = a; n++; console.log('actual', e.c, e.t, '=>', m.title, e.a); } }
      console.log('actuals matched', n, 'of', need.length);
    } catch (err) { console.log('actuals', String(err.message || err)); }
  }
  const out = { updated: new Date().toISOString(), ffAt: ffFresh, source: 'ForexFactory + TradingView', events };
  const strip = o => JSON.stringify({ ...o, updated: 0 });
  if (strip(out) === strip(old)) { console.log('calendar unchanged'); return; }
  await writeFile(path, JSON.stringify(out));
  console.log('calendar events', events.length);
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
