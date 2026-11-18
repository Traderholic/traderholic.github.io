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
// ForexFactory's own calendar page carries the actual figure seconds after release (same titles as our list).
const FF_MON = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
async function fetchFFActuals(days) {
  const out = new Map();
  for (const t of days) {
    const d = new Date(t - 5 * 3600000); // FF day pages follow New York's calendar day
    const url = `https://www.forexfactory.com/calendar?day=${FF_MON[d.getUTCMonth()]}${d.getUTCDate()}.${d.getUTCFullYear()}`;
    try {
      // curl, not fetch: the site's firewall refuses Node's HTTP client but accepts curl
      const html = execFileSync('curl', ['-s', '--compressed', '-m', '15', '-A', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36', '-H', 'Accept-Language: en-US', url], { maxBuffer: 1 << 24 }).toString();
      if (!html.includes('"dateline"')) { console.log('ff page: no calendar data', html.length); continue; }
      const re = /\{"id":\d+,"ebaseId":\d+,"name":"((?:[^"\\]|\\.)*)"[^{}]*?"dateline":(\d+)[^{}]*?"currency":"(\w*)"[^{}]*?"actual":"((?:[^"\\]|\\.)*)"/g;
      let m; while ((m = re.exec(html))) {
        const name = m[1].replace(/\\\//g, '/').replace(/\\u0026/g, '&'), actual = m[4].replace(/\\\//g, '/');
        if (actual) out.set(m[3] + '|' + name + '|' + (+m[2] * 1000), actual);
      }
    } catch (e) { console.log('ff page', String(e.message || e).slice(0, 100)); }
  }
  return out;
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
  // work on a copy so the 'unchanged' check below compares against the file as it was
  let events = (old.events || []).map(e => ({ ...e }));
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
    && Date.parse(e.d) <= now && Date.parse(e.d) >= now - 3 * 86400000);
  if (need.length) {
    // 1) ForexFactory page: fastest, exact titles
    try {
      const recentNeed = need.filter(e => now - Date.parse(e.d) < 24 * 3600000);
      const days = [...new Set(recentNeed.map(e => { const d = new Date(Date.parse(e.d) - 5 * 3600000); return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) + 5 * 3600000; }))].slice(-2);
      const ff = days.length ? await fetchFFActuals(days) : new Map(); let n = 0;
      for (const e of need) { const a = ff.get(e.c + '|' + e.t + '|' + Date.parse(e.d)); if (a) { e.a = a; n++; console.log('actual(ff)', e.c, e.t, a); } }
      if (n) console.log('ff actuals', n);
    } catch (err) { console.log('ff actuals', String(err.message || err)); }
  }
  const need2 = need.filter(e => !e.a);
  if (need2.length) {
    try {
      const tv = await fetchTV(now - 3 * 86400000 - 3600000, now + 3600000);
      const used = new Set(); let n = 0;
      for (const e of need2) { const m = matchTV(e, tv, used); const a = m && fmtActual(m.actual, e, m); if (a) { used.add(m.id); e.a = a; n++; console.log('actual', e.c, e.t, '=>', m.title, e.a); } }
      console.log('actuals matched', n, 'of', need2.length);
    } catch (err) { console.log('actuals', String(err.message || err)); }
  }
  const out = { updated: new Date().toISOString(), ffAt: ffFresh, source: 'ForexFactory + TradingView', events };
  const strip = o => JSON.stringify({ ...o, updated: 0 });
  if (strip(out) === strip(old)) { console.log('calendar unchanged'); return false; }
  await writeFile(path, JSON.stringify(out));
  console.log('calendar events', events.length);
  return true;
}
// Seconds until the next check: fast right around a release, slower otherwise.
async function nextDelay() {
  const d = await readJson('data/calendar.json'); const now = Date.now();
  const SPEECH = /Speaks|Testif|Press Conference|Statement|Minutes|Meeting|Speech|Hearing|Auction|Holiday/i;
  let delay = 60;
  for (const e of d?.events || []) {
    if (e.i === 'Holiday') continue;
    const t = Date.parse(e.d), big = e.i === 'High' || e.i === 'Medium';
    if (big && !SPEECH.test(e.t) && !e.a && t <= now && now - t < 4 * 60000) return 5;            // just released: every 5 s
    if (big && t > now && t - now < 3 * 60000) delay = Math.min(delay, 10);                         // about to release
    if (big && !SPEECH.test(e.t) && !e.a && t <= now && now - t < 40 * 60000) delay = Math.min(delay, 12);
    if (e.i === 'High' && t <= now && now - t < 95 * 60000) delay = Math.min(delay, 30);           // summary window
    if (e.i === 'Low' && !e.a && t <= now && now - t < 10 * 60000) delay = Math.min(delay, 20);
  }
  return delay;
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
    let source = tag(it, 'source') || tag(it, 'News:Source') || fallbackSource || '';
    if (!title || !/^https?:\/\//.test(link) || Number.isNaN(date)) continue;
    if (source && title.endsWith(' - ' + source)) title = title.slice(0, -(source.length + 3)).trim();
    out.push({ t: title, u: link, s: source, d: new Date(date).toISOString() });
  }
  return out;
}
// Headline quality: drop local-market price pages, too-short or mostly-Latin titles (tickers, ads).
const LOCAL_MKT = /شارك برأيك|(?:في|فى) (?:مصر|السعودية|الإمارات|الكويت|الأردن|المغرب|العراق|الجزائر|سوريا|لبنان|اليمن|قطر|عمان|عُمان|البحرين|تونس|ليبيا|السودان|فلسطين)|بالمصنعية|محلياً|المحلية/;
const cleanSrc = x => (x || '').replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/$/, '').split(/ : | - | \| /)[0].trim();
const goodTitle = t => { const ws = t.split(/\s+/).filter(Boolean); if (ws.length < 5) return false; const lat = (t.match(/[A-Za-z]/g) || []).length, ar = (t.match(/[\u0600-\u06FF]/g) || []).length; return ar > lat * 1.5; };
const bnews = q => `https://www.bing.com/news/search?q=${encodeURIComponent(q.replace(/\s*when:\S+/g, '').replace(/[()"]/g, ' ').replace(/\bOR\b/g, ' '))}&format=rss&setlang=ar&cc=SA&qft=sortbydate%3d%221%22`;
const gnews = q => `https://news.google.com/rss/search?q=${encodeURIComponent(q)}&hl=ar&gl=SA&ceid=SA%3Aar`;
const FEEDS = {
  gold: {
    primary: [gnews('(الذهب OR الفضة) (أوقية OR الأوقية OR الأونصة OR "المعدن الأصفر" OR الفيدرالي OR الدولار OR "المعدن النفيس" OR "الملاذ الآمن") when:2d')],
    exclude: /عيار|جنيه|جنيها|ريال|درهم|دينار|ليرة|الليرة|بالأسواق المحلية|محلات|الصاغة|المصوغات|سبيكة|سبائك|الجرام|للجرام|بالجرام/,
    bing: [bnews('الذهب الأونصة'), bnews('الفضة الأونصة')],
    must: /الذهب|الفضة|المعدن/,
    fallback: [{ url: 'https://www.fxstreet.com/rss/news', source: 'FXStreet', filter: /gold|xau|silver|xag/i }]
  },
  crypto: {
    primary: [gnews('(بتكوين OR البيتكوين OR "العملات الرقمية" OR "العملات المشفرة" OR إيثريوم) when:2d')],
    bing: [bnews('بيتكوين'), bnews('العملات المشفرة')],
    must: /بتكوين|بيتكوين|العملات الرقمية|العملات المشفرة|إيثريوم|إيثيريوم|كريبتو|الأصول الرقمية|سولانا/,
    fallback: [{ url: 'https://cointelegraph.com/rss', source: 'Cointelegraph' }]
  },
  markets: {
    primary: [gnews('("الفيدرالي الأمريكي" OR "وول ستريت" OR "الأسهم الأمريكية" OR "التضخم الأمريكي" OR "الفائدة الأمريكية" OR "مؤشر الدولار") when:2d')],
    bing: [bnews('وول ستريت الأسهم الأمريكية'), bnews('الفيدرالي الأمريكي الفائدة')],
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
    // two independent sources every time (Google News + Bing News), so one refusing never leaves the section stale
    for (const url of [...cfg.primary, ...(cfg.bing || [])]) { try { items.push(...parseRss(await get(url))); } catch (e) { console.log('news', key, String(e.message || e).slice(0, 120)); } }
    if (items.length < 6) {
      for (const f of cfg.fallback) {
        try { let more = parseRss(await get(f.url), f.source); if (f.filter) more = more.filter(x => f.filter.test(x.t)); items.push(...more); }
        catch (e) { console.log('news fallback', key, String(e.message || e)); }
      }
    }
    if (cfg.exclude) items = items.filter(x => !cfg.exclude.test(x.t) && !LOCAL_MKT.test(x.t));
    if (!cfg.exclude) items = items.filter(x => !LOCAL_MKT.test(x.t));
    if (cfg.must) items = items.filter(x => cfg.must.test(x.t) || !/[\u0600-\u06FF]/.test(x.t));
    items = items.filter(x => goodTitle(x.t) || !/[\u0600-\u06FF]/.test(x.t));
    items.forEach(x => { x.s = cleanSrc(x.s).replace(/ on MSN$/, ''); });
    const seen = new Set();
    items = items.filter(x => Date.parse(x.d) >= cutoff && Date.parse(x.d) <= Date.now() + 600000)
      .sort((a, b) => b.d.localeCompare(a.d))
      .filter(x => { const k = x.t.replace(/[^\p{L}\p{N}]/gu, '').slice(0, 60); if (seen.has(k)) return false; seen.add(k); return true; })
      .slice(0, 30);
    out[key] = items.length ? items : (old[key] || []);
    const newest = out[key][0] ? Math.round((Date.now() - Date.parse(out[key][0].d)) / 60000) : -1;
    console.log('news', key, items.length, 'newest', newest, 'min ago');
  }
  await writeIfChanged(path, out);
}

/* ---------------- Weekly recap ----------------
   Week performance (TradingView scanner), the week's key results (kept even after the calendar rolls over),
   and big-tech earnings for the coming days. */
const KW = 3 * 3600000;
const kwDate = t => new Date(t + KW);
function recapWeek(now = Date.now()) {
  const k = kwDate(now); const wd = k.getUTCDay(); // 0 Sun .. 6 Sat (Kuwait calendar day)
  const back = wd === 0 ? 6 : wd === 6 ? 5 : wd - 1; // days back to Monday
  const mon = Date.UTC(k.getUTCFullYear(), k.getUTCMonth(), k.getUTCDate() - back) - KW; // Monday 00:00 Kuwait
  return { from: mon, to: mon + 5 * 86400000 - 1, final: wd === 0 || wd === 6 };
}
const ASSETS = [
  ['XAU', 'OANDA:XAUUSD', 'الذهب', 'metals'], ['XAG', 'TVC:SILVER', 'الفضة', 'metals'],
  ['SPX', 'SP:SPX', 'S&P 500', 'stocks'], ['NDX', 'NASDAQ:NDX', 'ناسداك 100', 'stocks'], ['DJI', 'DJ:DJI', 'داو جونز', 'stocks'],
  ['BTC', 'BITSTAMP:BTCUSD', 'البتكوين', 'crypto'], ['ETH', 'BITSTAMP:ETHUSD', 'الإيثيريوم', 'crypto'], ['TOTAL', 'CRYPTOCAP:TOTAL', 'سوق الكريبتو', 'crypto'],
  ['DXY', 'TVC:DXY', 'مؤشر الدولار', 'usd']
];
const MEGA = ['NASDAQ:AAPL', 'NASDAQ:MSFT', 'NASDAQ:NVDA', 'NASDAQ:AMZN', 'NASDAQ:GOOGL', 'NASDAQ:META', 'NASDAQ:TSLA', 'NASDAQ:AVGO', 'NASDAQ:NFLX', 'NASDAQ:AMD',
  'NASDAQ:COST', 'NASDAQ:PLTR', 'NASDAQ:ADBE', 'NASDAQ:INTC', 'NASDAQ:MU', 'NASDAQ:PANW', 'NASDAQ:COIN', 'NASDAQ:MSTR', 'NYSE:BRK.B', 'NYSE:JPM', 'NYSE:V', 'NYSE:MA',
  'NYSE:WMT', 'NYSE:ORCL', 'NYSE:LLY', 'NYSE:UNH', 'NYSE:XOM', 'NYSE:HD', 'NYSE:LOW', 'NYSE:TGT', 'NYSE:CRM', 'NYSE:BAC', 'NYSE:DIS', 'NYSE:NKE', 'NYSE:BABA', 'NYSE:TSM', 'NYSE:SNOW'];
async function scan(market, tickers, columns) {
  const r = await fetch(`https://scanner.tradingview.com/${market}/scan`, { method: 'POST', headers: { 'content-type': 'application/json', 'user-agent': UA },
    body: JSON.stringify({ symbols: { tickers }, columns }), signal: AbortSignal.timeout(25000) });
  if (!r.ok) throw new Error('scan ' + r.status);
  const j = await r.json(); return new Map((j.data || []).map(x => [x.s, x.d]));
}
async function recap() {
  const path = 'data/recap.json';
  const old = (await readJson(path)) || {};
  const now = Date.now(), wk = recapWeek(now);
  const out = { updated: new Date().toISOString(), week: { from: new Date(wk.from).toISOString(), to: new Date(wk.to).toISOString(), final: wk.final } };
  // 1) performance
  try {
    const m = await scan('global', ASSETS.map(a => a[1]), ['close', 'Perf.W', 'Perf.1M', 'change']);
    out.perf = ASSETS.map(([k, s, n, g]) => { const d = m.get(s); return d ? { k, n, g, c: d[0], w: d[1], m: d[2], d: d[3] } : null; }).filter(Boolean);
  } catch (e) { console.log('recap perf', String(e.message || e)); }
  if (!out.perf?.length) out.perf = old.perf || [];
  // 2) results of the week (High + USD Medium), merged with what we kept earlier for the same week
  const cal = (await readJson('data/calendar.json'))?.events || [];
  const keep = new Map();
  if (old.week?.from === out.week.from) (old.results || []).forEach(e => keep.set(e.d + '|' + e.c + '|' + e.t, e));
  cal.forEach(e => { const t = Date.parse(e.d); if (t >= wk.from && t <= Math.min(now, wk.to + 2 * 86400000) && e.a && (e.i === 'High' || (e.i === 'Medium' && e.c === 'USD'))) keep.set(e.d + '|' + e.c + '|' + e.t, { t: e.t, c: e.c, d: e.d, i: e.i, f: e.f, p: e.p, a: e.a }); });
  out.results = [...keep.values()].sort((a, b) => a.d.localeCompare(b.d));
  const until = now + 8 * 86400000;
  // 4) big-tech earnings in the next 8 days
  try {
    const m = await scan('america', MEGA, ['description', 'earnings_release_next_date', 'earnings_per_share_forecast_next_fq', 'market_cap_basic']);
    out.earnings = MEGA.map(s => { const d = m.get(s); if (!d || !d[1]) return null; const t = d[1] * 1000; if (t < now - 12 * 3600000 || t > until) return null;
      return { s: s.split(':')[1], n: d[0], d: new Date(t).toISOString(), eps: d[2], cap: d[3] }; }).filter(Boolean).sort((a, b) => a.d.localeCompare(b.d) || b.cap - a.cap);
  } catch (e) { console.log('recap earnings', String(e.message || e)); out.earnings = old.earnings || []; }
  return writeIfChanged(path, out);
}

/* ---------------- Fear & Greed ---------------- */
async function sentiment() {
  const path = 'data/sentiment.json';
  const old = (await readJson(path)) || {};
  const out = { updated: new Date().toISOString() };
  try {
    const j = JSON.parse(await get('https://api.alternative.me/fng/?limit=31'));
    const h = (j.data || []).map(x => ({ v: +x.value, t: +x.timestamp * 1000 }));
    if (h.length) out.crypto = { v: h[0].v, t: h[0].t, prev: h[1]?.v, week: h[7]?.v, month: h[30]?.v, hist: h.slice(0, 31).reverse().map(x => x.v) };
  } catch (e) { console.log('fng crypto', String(e.message || e)); }
  try {
    const r = await fetch('https://production.dataviz.cnn.io/index/fearandgreed/graphdata', { headers: { 'user-agent': UA, referer: 'https://edition.cnn.com/', accept: 'application/json' }, signal: AbortSignal.timeout(25000) });
    if (!r.ok) throw new Error('cnn ' + r.status);
    const j = await r.json(); const f = j.fear_and_greed;
    const hist = (j.fear_and_greed_historical?.data || []).slice(-31).map(x => Math.round(x.y));
    if (f) out.stocks = { v: Math.round(f.score), t: Date.parse(f.timestamp), prev: Math.round(f.previous_close), week: Math.round(f.previous_1_week), month: Math.round(f.previous_1_month), hist };
  } catch (e) { console.log('fng stocks', String(e.message || e)); }
  out.crypto ??= old.crypto; out.stocks ??= old.stocks;
  return writeIfChanged(path, out);
}

/* ---------------- Push notifications (OneSignal) ----------------
   15 minutes before every high-impact release, and again when its actual figure lands.
   push-config.json holds the public App ID; the API key comes from the ONESIGNAL_API_KEY secret. */
import { createHash } from 'node:crypto';
const IMPACT = [
  { re: /Speaks|Testif|Press Conference|Statement|Minutes|Meeting|Speech|Hearing/i, up: null },
  { re: /Funds Rate|Rate Decision|Interest Rate|Cash Rate|Bank Rate|Refinancing Rate|Policy Rate|Deposit Facility/i, up: 'hawk' },
  { re: /CPI|PCE|PPI|Inflation|Price Index|Employment Cost|Average Hourly Earnings/i, up: 'hawk' },
  { re: /Unemployment Rate/i, up: 'weak' }, { re: /Claims/i, up: 'weak' }
];
const CUR = { USD: 'الدولار', EUR: 'اليورو', GBP: 'الجنيه', JPY: 'الين', CNY: 'اليوان' };
function effectLine(e, dir) { // dir: 'up' | 'down' relative to forecast
  const g = IMPACT.find(x => x.re.test(e.t)); const up = g ? g.up : 'hawk'; if (!up) return '';
  const curUp = (up === 'hawk') === (dir === 'up'); // currency strengthens?
  const a = s => s ? '▲' : '▼';
  if (e.c === 'USD') return `الدولار ${a(curUp)} · الذهب ${a(!curUp)} · الفضة ${a(!curUp)} · البتكوين ${a(!curUp)}`;
  return `${CUR[e.c] || e.c} ${a(curUp)} · الدولار ${a(!curUp)} (غير مباشر)`;
}
const uuidOf = s => { const h = createHash('sha1').update(s).digest('hex'); return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`; };
const hhmm = t => new Date(t + KW).toISOString().slice(11, 16);
async function sendPush(cfg, key, heading, body) {
  const r = await fetch('https://api.onesignal.com/notifications?c=push', {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Key ' + process.env.ONESIGNAL_API_KEY },
    body: JSON.stringify({ app_id: cfg.appId, included_segments: ['Total Subscriptions'], target_channel: 'push', idempotency_key: uuidOf(key),
      headings: { en: heading, ar: heading }, contents: { en: body, ar: body }, url: 'https://traderholic.github.io/#calendar',
      chrome_web_icon: 'https://traderholic.github.io/icons/icon-192.png', ttl: 3600 }),
    signal: AbortSignal.timeout(20000)
  });
  const txt = await r.text(); console.log('push', r.status, key, txt.slice(0, 200));
  return r.ok;
}
function resultLine(e) {
  const a = num(e.a), f = num(e.f);
  if (IMPACT[1].re.test(e.t)) {
    const p = num(e.p); const w = p == null || a == null ? '' : a > p ? 'رفع' : a < p ? 'خفض' : 'تثبيت';
    const vs = f == null ? '' : a > f ? ' (أعلى من المتوقع)' : a < f ? ' (أقل من المتوقع)' : ' (مثل المتوقع)';
    const dir = f == null || a === f ? null : a > f ? 'up' : 'down';
    return `${e.t}: ${e.a}${w ? ' · ' + w : ''}${vs}` + (dir ? '\n' + effectLine(e, dir) : '');
  }
  if (f == null) return `${e.t}: ${e.a}`;
  const dir = a > f ? 'up' : a < f ? 'down' : 'eq';
  const word = dir === 'up' ? 'أعلى من المتوقع ⬆️' : dir === 'down' ? 'أقل من المتوقع ⬇️' : 'مطابق للمتوقع';
  return `${e.t}: ${e.a} (المتوقع ${e.f}) ${word}` + (dir === 'eq' ? '' : '\n' + effectLine(e, dir));
}
function rateHeadline(e) {
  const a = num(e.a), p = num(e.p); const bank = { USD: 'الفيدرالي', EUR: 'المركزي الأوروبي', GBP: 'بنك إنجلترا', JPY: 'بنك اليابان' }[e.c] || 'البنك المركزي';
  if (a == null || p == null) return `قرار ${bank}: ${e.a}`;
  return a > p ? `${bank} يرفع الفائدة إلى ${e.a}` : a < p ? `${bank} يخفض الفائدة إلى ${e.a}` : `${bank} يثبت الفائدة عند ${e.a}`;
}
async function pushAlerts() {
  const cfg = await readJson('push-config.json');
  if (!cfg?.appId || !process.env.ONESIGNAL_API_KEY) return false;
  const logPath = 'data/push-log.json';
  const log = (await readJson(logPath)) || { sent: {} };
  const now = Date.now(); let changed = false;
  for (const [k, t] of Object.entries(log.sent)) if (now - Date.parse(t) > 4 * 86400000) { delete log.sent[k]; changed = true; }
  const cal = (await readJson('data/calendar.json'))?.events || [];
  const hi = cal.filter(e => e.i === 'High');
  const byTime = new Map(); hi.forEach(e => { const k = e.d; if (!byTime.has(k)) byTime.set(k, []); byTime.get(k).push(e); });
  for (const [d, list] of byTime) {
    const t = Date.parse(d);
    // before
    const preKey = 'pre|' + d + '|' + list.map(e => e.c + e.t).join(',');
    if (t - now > 0 && t - now <= 15.5 * 60000 && !log.sent[preKey]) {
      const mins = Math.max(1, Math.round((t - now) / 60000));
      const body = list.map(e => `${e.c} · ${e.t}${e.f ? ' (المتوقع ' + e.f + ')' : ''}`).join('\n') + '\nانتبه: السبريد يتسع والحركة تكون قوية.';
      const mw = mins === 1 ? 'دقيقة' : mins === 2 ? 'دقيقتين' : mins <= 10 ? mins + ' دقائق' : mins + ' دقيقة';
      if (await sendPush(cfg, preKey, `⏰ خبر قوي بعد ${mw} · ${hhmm(t)} بتوقيت الكويت`, body)) { log.sent[preKey] = new Date().toISOString(); changed = true; }
    }
    // after: send as soon as figures land. Items of the same time slot that arrive within ~30 s go in one alert;
    // anything arriving later gets its own alert, so nobody waits on a slow item.
    const withFig = list.filter(e => !IMPACT[0].re.test(e.t));
    const fresh = withFig.filter(e => e.a && !log.sent['res1|' + keyOf(e)]);
    if (fresh.length && now - t < 60 * 60000) {
      const seenK = 'seen|' + d;
      if (!log.sent[seenK]) { log.sent[seenK] = new Date().toISOString(); changed = true; }
      const waiting = withFig.some(e => !e.a) && now - Date.parse(log.sent[seenK]) < 30000 && now - t < 3 * 60000;
      if (!waiting) {
        const lines = fresh.map(resultLine);
        const resKey = 'res|' + d + '|' + fresh.map(e => e.c + e.t).join(',');
        const rate = fresh.find(e => IMPACT[1].re.test(e.t));
        const head = rate ? `🏦 ${rateHeadline(rate)}` : `📊 صدر الخبر · ${fresh[0].c} · ${hhmm(t)}`;
        if (await sendPush(cfg, resKey, head, lines.join('\n'))) { fresh.forEach(e => { log.sent['res1|' + keyOf(e)] = new Date().toISOString(); }); changed = true; }
      }
    }
  }
  if (changed) await writeFile(logPath, JSON.stringify(log));
  return changed;
}

/* ---------------- Summaries of high-impact events ----------------
   After a central-bank decision, speech or press conference (and after big data releases), collect the first
   wire headlines (English wires publish within minutes), translate them to Arabic, push a short summary and
   keep it in data/summaries.json so the calendar can show it under the event. */
const WIRES = /Reuters|Bloomberg|CNBC|Wall Street Journal|WSJ|Financial Times|MarketWatch|Barron|Axios|AP News|Associated Press|FXStreet|ForexLive|Investing\.com|Yahoo|Fox Business|Business Insider|Kitco|CNN|Morningstar|Nasdaq|The Hill|Politico|NBC|CBS|ABC|Forbes|Fortune|Coindesk|Cointelegraph|The Block|Federal Reserve/i;
const NOT_NEWS = /watch live|live:|livestream|live updates|preview|what to expect|ahead of|to speak|will speak|set to|schedule|how to watch|calendar|week ahead|podcast|video/i;
const BANK = { USD: 'Fed', EUR: 'ECB', GBP: '"Bank of England"', JPY: '"Bank of Japan"' };
const BANK_AR = { USD: 'الفيدرالي', EUR: 'المركزي الأوروبي', GBP: 'بنك إنجلترا', JPY: 'بنك اليابان' };
const TOPIC = [
  [/CPI|Inflation/i, 'inflation CPI'], [/PCE/i, 'PCE inflation'], [/PPI/i, 'producer prices PPI'],
  [/Non-Farm|NFP|Payrolls/i, 'payrolls jobs report'], [/Unemployment Rate/i, 'unemployment rate'], [/Claims/i, 'jobless claims'],
  [/GDP/i, 'GDP economy'], [/Retail Sales/i, 'retail sales'], [/ISM|PMI/i, 'ISM PMI'], [/JOLTS/i, 'job openings JOLTS']
];
function summaryQuery(e) {
  const bank = BANK[e.c]; if (!bank) return null;
  const name = (e.t.match(/([A-Z][a-z]+) (?:Speaks|Testifies|Speech)/) || [])[1];
  if (IMPACT[0].re.test(e.t) || IMPACT[1].re.test(e.t)) return name ? `(${name} OR ${bank}) when:2h` : `(${bank} OR "rate decision") when:2h`;
  if (e.c !== 'USD') return null;
  const tp = TOPIC.find(([re]) => re.test(e.t)); return tp ? `US ${tp[1]} when:2h` : null;
}
const tidyAr = s => s.trim().replace(/\s*من بنك الاحتياطي الفيدرالي/g, '').replace(/بنك الاحتياطي الفيدرالي/g, 'الفيدرالي').replace(/^و(يقول|يرى|قال|يحذر)/, '$1').replace(/\s{2,}/g, ' ');
async function translateAr(text) {
  try { // Google's dictionary endpoint (works from servers), then MyMemory as a fallback
    const r = await fetch('https://clients5.google.com/translate_a/t?client=dict-chrome-ex&sl=en&tl=ar&q=' + encodeURIComponent(text), { headers: { 'user-agent': UA }, signal: AbortSignal.timeout(12000) });
    if (r.ok) { const j = await r.json(); const out = Array.isArray(j) ? (Array.isArray(j[0]) ? j[0][0] : j[0]) : null; if (typeof out === 'string' && /[\u0600-\u06FF]/.test(out)) return tidyAr(out); }
  } catch { /* try the next one */ }
  try {
    const r = await fetch('https://api.mymemory.translated.net/get?langpair=en|ar&q=' + encodeURIComponent(text), { signal: AbortSignal.timeout(12000) });
    if (r.ok) { const j = await r.json(); const out = j?.responseData?.translatedText; if (out && /[\u0600-\u06FF]/.test(out)) return tidyAr(out); }
  } catch { /* give up */ }
  return null;
}
const SAYS = /\bsays?\b|\bsaid\b|\bsees\b|\bwarns?\b|\bsignals?\b|\bstresses\b|\bexpects?\b|\bholds?\b|\bcuts?\b|\braises?\b|\bkeeps?\b|\bleaves?\b|\brises?\b|\bfalls?\b|\bjumps?\b|\bslows?\b|\bcools?\b|\bbeats?\b|\bmiss(es)?\b|:/i;
function pickHeadlines(items, since, max, skip = new Set(), mustWire = false, name = '') {
  const words = t => new Set(t.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter(w => w.length > 3));
  const score = x => (SAYS.test(x.t) ? 3 : 0) + (name && x.t.includes(name) ? 2 : 0) + (WIRES.test(x.s) ? 1.5 : 0);
  const picked = [];
  const good = items.filter(x => Date.parse(x.d) >= since && !NOT_NEWS.test(x.t) && !skip.has(x.t) && (!mustWire || WIRES.test(x.s)) && SAYS.test(x.t))
    .sort((a, b) => score(b) - score(a) || Date.parse(b.d) - Date.parse(a.d));
  for (const x of good) {
    const w = words(x.t);
    if (picked.some(p => { let n = 0; w.forEach(z => { if (p.w.has(z)) n++; }); return n / Math.max(1, Math.min(w.size, p.w.size)) > 0.45; })) continue;
    picked.push({ x, w }); if (picked.length === max) break;
  }
  return picked.map(p => p.x);
}
// Headlines for summaries: Google News first, then Bing News, then the fast FX wires (a runner IP can get blocked by one of them).
async function fetchSummaryHeadlines(q, kw) {
  const plain = q.replace(/\s*when:\S+/g, '');
  // InvestingLive (formerly ForexLive) posts central-bank remarks within a minute or two, so it is always read first;
  // the search engines add depth. FXStreet answers runners with 403, so it is not used.
  const tries = [
    ['https://investinglive.com/feed/news', 'InvestingLive'],
    [`https://news.google.com/rss/search?q=${encodeURIComponent(q)}&hl=en-US&gl=US&ceid=US%3Aen`, null],
    [`https://www.bing.com/news/search?q=${encodeURIComponent(plain)}&format=rss&qft=sortbydate%3d%221%22`, null]
  ];
  let engines = 0;
  let all = [];
  for (const [url, src] of tries) {
    try {
      let items = parseRss(await get(url), src || '');
      items.forEach(x => { if (!x.s) { try { x.s = new URL(x.u).hostname.replace(/^www\./, ''); } catch { /* keep empty */ } } x.s = x.s.replace(/<[^>]*>/g, ''); });
      items = items.filter(x => kw.test(x.t)); // every source: only headlines about this event (searches also return sports, other people)
      all = all.concat(items);
      if (!src && items.length >= 5 && ++engines) break; // one search engine answered well; no need for the second
    } catch (err) { console.log('summary src', String(err.message || err).slice(0, 120)); }
  }
  return all;
}
const SUM_LAST = new Map();
async function summaries() {
  const path = 'data/summaries.json';
  const store = (await readJson(path)) || {};
  const now = Date.now(); let changed = false;
  for (const k of Object.keys(store)) if (now - Date.parse(store[k].at || 0) > 8 * 86400000) { delete store[k]; changed = true; }
  const cal = (await readJson('data/calendar.json'))?.events || [];
  // one summary per time slot: prefer the speech / press conference / rate decision, else the first data item
  const slots = new Map();
  for (const e of cal) { if (e.i !== 'High' || !summaryQuery(e)) continue; const t = Date.parse(e.d); if (!(now - t > 3 * 60000 && now - t < 95 * 60000)) continue;
    const cur = slots.get(e.d); const rank = x => IMPACT[0].re.test(x.t) ? 0 : IMPACT[1].re.test(x.t) ? 1 : 2; if (!cur || rank(e) < rank(cur)) slots.set(e.d, e); }
  const cfg = await readJson('push-config.json');
  for (const [d, e] of slots) {
    const t = Date.parse(d), key = keyOf(e), cur = store[key];
    const isTalk = IMPACT[0].re.test(e.t) || IMPACT[1].re.test(e.t);
    // stage 1 as soon as there is 1 relevant headline (talks) or 2 after 6 min (data); stage 2 update after 15 min for talks
    const stage = !cur ? 1 : (isTalk && cur.stage === 1 && now - t > 15 * 60000) ? 2 : 0;
    if (!stage) continue;
    if (!isTalk && now - t < 6 * 60000) continue;
    if (now - (SUM_LAST.get(key + stage) || 0) < 60000) continue; // at most one news query a minute per event
    SUM_LAST.set(key + stage, now);
    let items = [];
    const nm0 = (e.t.match(/([A-Z][a-z]+) (?:Speaks|Testifies|Speech)/) || [])[1];
    const POLICY = 'rate|inflation|policy|econom|labou?r|jobs|prices|hike|cut|growth|recession|tariff|yields?|currency|sterling|dollar|euro|yen';
    const kw0 = new RegExp([nm0, { USD: 'Fed|FOMC|Federal Reserve', EUR: 'ECB|Lagarde', GBP: 'BoE|Bank of England|Bailey', JPY: 'BoJ|Bank of Japan|Ueda' }[e.c] || 'Fed'].filter(Boolean).join('|') + (isTalk ? '' : '|' + (TOPIC.find(([re]) => re.test(e.t)) || [, ''])[1].split(' ').join('|')), 'i');
    const bankRe = { USD: /\bFed\b|FOMC|Federal Reserve/i, EUR: /\bECB\b|European Central Bank/i, GBP: /\bBoE\b|\bBOE\b|Bank of England/i, JPY: /\bBoJ\b|\bBOJ\b|Bank of Japan/i }[e.c] || /\bFed\b/;
    const kw = isTalk ? { test: t => bankRe.test(t) || (!!nm0 && t.includes(nm0) && new RegExp(POLICY, 'i').test(t)) } : kw0;
    items = await fetchSummaryHeadlines(summaryQuery(e), kw);
    if (!items.length) continue;
    const skip = new Set((cur?.items || []).map(x => x.en));
    const nm = (e.t.match(/([A-Z][a-z]+) (?:Speaks|Testifies|Speech)/) || [])[1] || '';
    const picked = pickHeadlines(items, t - 3 * 60000, 3, skip, !isTalk, nm);
    console.log('summary check', stage, e.t, 'headlines', items.length, 'picked', picked.length);
    if (picked.length < (isTalk ? 1 : 2)) { if (stage === 2 && now - t > 80 * 60000) { cur.stage = 3; changed = true; } continue; }
    const out = [];
    for (const x of picked) out.push({ en: x.t, ar: (await translateAr(x.t)) || x.t, s: x.s, u: x.u, d: x.d });
    const entry = cur || { t: e.t, c: e.c, d: e.d, items: [] };
    entry.items = [...(entry.items || []), ...out]; entry.stage = stage; entry.at = new Date().toISOString();
    store[key] = entry; changed = true;
    console.log('summary', stage, e.c, e.t, out.map(x => x.ar).join(' | '));
    if (cfg?.appId && process.env.ONESIGNAL_API_KEY && !process.env.DRY) {
      const who = (e.t.match(/([A-Z][a-z]+) (?:Speaks|Testifies)/) || [])[1];
      const title = isTalk ? `🎙️ ${stage === 2 ? 'تحديث: ' : ''}أبرز ما قيل · ${BANK_AR[e.c] || e.c}${who ? ' (' + who + ')' : ''}` : `📰 ملخص الخبر · ${e.t}`;
      await sendPush(cfg, 'sum|' + stage + '|' + key, title, out.map(x => '• ' + x.ar).join('\n'));
    }
  }
  if (changed) await writeFile(path, JSON.stringify(store));
  return changed;
}

/* ---------------- Runner ----------------
   GitHub's scheduled runs are often late or skipped, so one job stays alive for hours and checks in a loop:
   every ~12 s around a release, every minute otherwise; news every 10 minutes. Changes are committed and pushed at once. */
import { execSync, execFileSync } from 'node:child_process';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const sh = c => execSync(c, { stdio: 'pipe' }).toString().trim();
async function publish(msg) {
  sh('git add data');
  try { sh('git diff --cached --quiet'); return false; } catch { /* there are changes */ }
  sh(`git commit -q -m "${msg}"`);
  for (let i = 0; i < 5; i++) {
    try { sh('git pull -q --rebase origin main'); sh('git push -q origin main'); console.log(new Date().toISOString(), 'pushed:', msg); return true; }
    catch (e) { console.log('push retry', String(e.message || e).slice(0, 200)); await sleep(4000); }
  }
  return false;
}
await mkdir('data', { recursive: true });
if (process.argv.includes('--ff-test')) {
  // check the ForexFactory page source: node scripts/update.mjs --ff-test
  const m = await fetchFFActuals([Date.now() - 6 * 3600000]); console.log('ff size', m.size); for (const [k, v] of [...m].slice(0, 40)) console.log(k, v);
} else if (process.argv.includes('--summary-test')) {
  // dry run against a past event: node scripts/update.mjs --summary-test "<ISO date>|<currency>|<title>"
  const [d, c, t] = process.argv[process.argv.indexOf('--summary-test') + 1].split('|');
  const e = { d, c, t, i: 'High' }; console.log('query:', summaryQuery(e));
  const items = await fetchSummaryHeadlines(summaryQuery(e), /Warsh|Fed|FOMC/i);
  const nm = (t.match(/([A-Z][a-z]+) (?:Speaks|Testifies|Speech)/) || [])[1] || '';
  for (const x of pickHeadlines(items, Date.parse(d) - 3 * 60000, 3, new Set(), !(IMPACT[0].re.test(t) || IMPACT[1].re.test(t)), nm)) console.log('-', x.d, x.s, '|', x.t, '\n  →', await translateAr(x.t));
} else if (!process.argv.includes('--watch')) {
  await calendar().catch(e => console.log('calendar failed', e));
  await news().catch(e => console.log('news failed', e));
  await recap().catch(e => console.log('recap failed', e));
  await sentiment().catch(e => console.log('sentiment failed', e));
} else {
  const end = Date.now() + (Number(process.env.WATCH_MINUTES) || 330) * 60000;
  let lastNews = 0, lastSlow = 0;
  while (Date.now() < end) {
    try { sh('git pull -q --rebase origin main'); } catch (e) { console.log('pull failed', String(e.message || e).slice(0, 200)); }
    const changed = await calendar().catch(e => { console.log('calendar failed', e); return false; });
    const pushed = await pushAlerts().catch(e => { console.log('push failed', e); return false; });
    if (changed || pushed) await publish('data: calendar update');
    if (await summaries().catch(e => { console.log('summaries failed', e); return false; })) await publish('data: event summary');
    if (Date.now() - lastSlow > 30 * 60000) {
      lastSlow = Date.now();
      await recap().catch(e => console.log('recap failed', e));
      await sentiment().catch(e => console.log('sentiment failed', e));
      await publish('data: recap and sentiment');
    }
    if (Date.now() - lastNews > 5 * 60000) {
      lastNews = Date.now();
      await news().catch(e => console.log('news failed', e));
      await publish('data: news update');
    }
    await sleep((await nextDelay().catch(() => 60)) * 1000);
  }
}
