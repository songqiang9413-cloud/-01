const UA_MOBILE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';
function extractRouterData(html) {
  const at = html.indexOf('_ROUTER_DATA'); if (at < 0) return null;
  const start = html.indexOf('{', at);
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < html.length; i += 1) {
    const ch = html[i];
    if (inStr) { if (esc) esc = false; else if (ch === '\\') esc = true; else if (ch === '"') inStr = false; continue; }
    if (ch === '"') inStr = true;
    else if (ch === '{') depth += 1;
    else if (ch === '}') { depth -= 1; if (depth === 0) return JSON.parse(html.slice(start, i + 1)); }
  }
  return null;
}
function probe(url, label, cookie) {
  return fetch(url, { headers: { 'user-agent': UA_MOBILE, referer: 'https://www.douyin.com/', cookie }, redirect: 'follow', signal: AbortSignal.timeout(20000) })
    .then(async (r) => {
      const len = r.headers.get('content-length');
      console.log(label.padEnd(10), '| HTTP', r.status, '| 大小', len ? (num(len) / 1048576).toFixed(2) + 'MB' : '?', '| CDN 路径:', new URL(r.url).pathname.slice(0, 90));
      r.body.cancel();
      return Number(len) || 0;
    })
    .catch((e) => { console.log(label.padEnd(10), '失败:', e.message); return 0; });
}
function num(v) { return Number(v) || 0; }
(async () => {
  const reg = await fetch('https://ttwid.bytedance.com/ttwid/union/register/', {
    method: 'POST', headers: { 'content-type': 'application/json', 'user-agent': UA_MOBILE },
    body: JSON.stringify({ region: 'cn', aid: 1768, needFid: false, service: 'www.ixigua.com', migrate_info: { ticket: '', source: 'node' }, cbUrlProtocol: 'https', union: true }),
    signal: AbortSignal.timeout(12000),
  });
  const ttwid = ((reg.headers.getSetCookie() || []).join('; ').match(/ttwid=([^;]+)/) || [])[1];
  const html = await (await fetch('https://www.iesdouyin.com/share/video/7588908199673037915/', { headers: { 'user-agent': UA_MOBILE, cookie: 'ttwid=' + ttwid }, signal: AbortSignal.timeout(15000) })).text();
  const item = (extractRouterData(html).loaderData || {})['video_(id)/page'].videoInfoRes.item_list[0];

  const wm = ((item.video.play_addr || {}).url_list || [])[0];
  const noWm = wm.replace('/playwm/', '/play/');
  console.log('带水印地址:', wm);
  console.log('替换后地址:', noWm);
  console.log('');
  await probe(wm, 'playwm', 'ttwid=' + ttwid);
  await probe(noWm, 'play', 'ttwid=' + ttwid);
  console.log('\n（playwm 是带水印版，play 是原片；两者 CDN 路径和体积不同就说明替换生效）');
})().catch((e) => console.log('失败:', e.message));
