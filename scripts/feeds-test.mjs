// One-off check: which headline sources answer from the runner, and how early they carried a given speaker.
const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';
const kw = new RegExp(process.env.KW || 'Bailey|BoE|Bank of England', 'i');
const q = process.env.Q || '(Bailey OR "Bank of England") when:2h';
const urls = [
  'https://www.forexlive.com/feed/news', 'https://investinglive.com/feed/news', 'https://investinglive.com/feed',
  'https://investinglive.com/rss', 'https://www.fxstreet.com/rss/news',
  `https://news.google.com/rss/search?q=${encodeURIComponent(q)}&hl=en-US&gl=US&ceid=US%3Aen`,
  `https://www.bing.com/news/search?q=${encodeURIComponent(q.replace(/\s*when:\S+/g, ''))}&format=rss&qft=sortbydate%3d%221%22`
];
for (const u of urls) {
  const t0 = Date.now();
  try {
    const r = await fetch(u, { headers: { 'user-agent': UA, accept: '*/*' }, redirect: 'follow', signal: AbortSignal.timeout(25000) });
    const x = await r.text();
    const items = [...x.matchAll(/<item[\s>]([\s\S]*?)<\/item>/gi)].map(m => ({
      t: (m[1].match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1]?.replace(/<!\[CDATA\[|\]\]>/g, '').trim(),
      d: (m[1].match(/<pubDate[^>]*>([\s\S]*?)<\/pubDate>/i) || [])[1]
    }));
    console.log(`\n== ${r.status} ${r.url} (${Date.now() - t0} ms) items ${items.length}`);
    for (const i of items.filter(i => kw.test(i.t || '')).slice(0, 12)) console.log('  ', new Date(i.d).toISOString(), '|', i.t);
  } catch (e) { console.log(`\n== FAIL ${u}: ${String(e.message || e).slice(0, 150)}`); }
}
