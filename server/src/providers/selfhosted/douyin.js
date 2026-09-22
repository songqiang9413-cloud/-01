/**
 * 抖音解析（自建，不依赖任何第三方付费接口）
 * ------------------------------------------------------------------
 * 工作原理（2026-09 实测有效）：
 *   1. 短链 v.douyin.com/xxx 手动跟随跳转，从最终地址里取出 19 位作品 ID
 *   2. 向公开的 ttwid 注册接口申请一个匿名凭证（Cookie），缓存 30 分钟复用
 *   3. 带这个凭证请求分享页 https://www.iesdouyin.com/share/video/{id}/
 *      页面里的 window._ROUTER_DATA 是一段完整 JSON，视频信息就在里面
 *   4. 取 video.play_addr.url_list[0]，把 /playwm/ 换成 /play/
 *      这是关键一步：playwm = with watermark（带水印），play = 原片
 *
 * 为什么不用「逆向签名接口」：抖音 Web API 需要 a_bogus 签名，逆向它既有技术成本
 * 也有合规风险。走分享页 HTML 这条路不需要碰签名算法。
 *
 * ⚠️ 维护提醒：这条路依赖抖音的页面结构，平台改版时会失效。
 *    失效的现象是 _ROUTER_DATA 里不再有 videoInfoRes → 需要重新抓一次页面结构。
 *    建议在 .env 里配 PARSE_FALLBACK_PROVIDER=http，自建挂了自动降级到第三方接口。
 */

const { HttpClient } = require('./http');

const TOKEN_TTL = 30 * 60 * 1000; // ttwid 缓存 30 分钟
const TOKEN_URL = 'https://ttwid.bytedance.com/ttwid/union/register/';

let tokenCache = { value: '', at: 0 };

/** 申请/复用 ttwid 凭证 */
async function ensureToken(client) {
  if (tokenCache.value && Date.now() - tokenCache.at < TOKEN_TTL) {
    client.setCookie('ttwid', tokenCache.value);
    return tokenCache.value;
  }
  const res = await client.postJson(TOKEN_URL, {
    region: 'cn',
    aid: 1768,
    needFid: false,
    service: 'www.ixigua.com',
    migrate_info: { ticket: '', source: 'node' },
    cbUrlProtocol: 'https',
    union: true,
  });
  const ttwid = client.jar.ttwid;
  if (!ttwid) {
    throw Object.assign(new Error('获取抖音访问凭证失败'), { code: 1002, raw: String(res.text).slice(0, 200) });
  }
  tokenCache = { value: ttwid, at: Date.now() };
  return ttwid;
}

/**
 * 从 HTML 里抠出 `_ROUTER_DATA = {...}` 这段 JSON
 * 不能用正则：JSON 里有嵌套对象和字符串里的花括号，必须做括号配对扫描
 */
function extractRouterData(html) {
  const marker = '_ROUTER_DATA';
  const at = html.indexOf(marker);
  if (at < 0) return null;
  const start = html.indexOf('{', at);
  if (start < 0) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < html.length; i += 1) {
    const ch = html[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) {
        try {
          return JSON.parse(html.slice(start, i + 1));
        } catch (err) {
          return null;
        }
      }
    }
  }
  return null;
}

/** 从各种形态的链接里取作品 ID */
function pickItemId(url) {
  const text = String(url || '');
  const patterns = [
    /(?:video|note|share\/video|share\/note)\/(\d{15,25})/i,
    /[?&](?:modal_id|aweme_id|item_ids?)=(\d{15,25})/i,
    /(\d{19})(?!\d)/,
  ];
  for (let i = 0; i < patterns.length; i += 1) {
    const m = text.match(patterns[i]);
    if (m) return m[1];
  }
  return '';
}

/** 把带水印地址换成原片地址：playwm → play */
function toNoWatermark(u) {
  return String(u || '').replace('/playwm/', '/play/').replace('playwm', 'play');
}

/** 从候选里挑最高画质的地址 */
function pickBestPlayUrl(video) {
  const candidates = [];
  const push = (addr, label) => {
    const list = (addr && addr.url_list) || [];
    if (list[0]) candidates.push({ url: list[0], label });
  };
  push(video.play_addr, 'default');
  push(video.play_addr_h264, 'h264');
  (video.bit_rate || []).forEach((item) => {
    const list = (item.play_addr && item.play_addr.url_list) || [];
    if (list[0]) candidates.push({ url: list[0], label: item.gear_name || 'gear', kbps: item.bit_rate || 0 });
  });
  if (!candidates.length) return '';
  // 有码率信息的按码率排，没有就用默认的
  const withRate = candidates.filter((c) => c.kbps);
  if (withRate.length) {
    withRate.sort((a, b) => b.kbps - a.kbps);
    return withRate[0].url;
  }
  return candidates[0].url;
}

function firstUrl(list) {
  return (list && list[0]) || '';
}

async function parse({ url }) {
  const client = new HttpClient({ timeout: 15000 });
  await ensureToken(client);

  // 1) 短链 → 拿到作品 ID
  let itemId = pickItemId(url);
  let finalUrl = url;
  if (!itemId) {
    finalUrl = await client.follow(url, 5);
    itemId = pickItemId(finalUrl);
  }
  if (!itemId) {
    throw Object.assign(new Error('没能从链接里识别出抖音作品，请复制 App 里「分享 → 复制链接」的完整内容'), {
      code: 1002,
      raw: 'final=' + String(finalUrl).slice(0, 120),
    });
  }

  // 2) 拉分享页
  const shareUrl = 'https://www.iesdouyin.com/share/video/' + itemId + '/';
  const res = await client.getText(shareUrl, { timeout: 15000 });
  const page = ((extractRouterData(res.text) || {}).loaderData || {})['video_(id)/page'] || {};
  const info = page.videoInfoRes || page.noteInfoRes || {};
  const item = (info.item_list || [])[0];

  if (!item) {
    // 凭证过期或平台改版时会出现这种情况：重取一次凭证再试一遍
    tokenCache = { value: '', at: 0 };
    await ensureToken(client);
    const retry = await client.getText(shareUrl, { timeout: 15000 });
    const page2 = ((extractRouterData(retry.text) || {}).loaderData || {})['video_(id)/page'] || {};
    const info2 = page2.videoInfoRes || {};
    const item2 = (info2.item_list || [])[0];
    if (!item2) {
      const statusCode = info2.status_code || info.status_code;
      const hint = statusCode ? '（平台返回状态码 ' + statusCode + '，作品可能已删除或设为私密）' : '（页面结构可能已改版）';
      throw Object.assign(new Error('解析失败，作品可能已删除或链接已过期 ' + hint), {
        code: 1002,
        raw: 'item_id=' + itemId + ' html_len=' + res.text.length,
      });
    }
    return buildResult(item2, itemId);
  }

  return buildResult(item, itemId);
}

function buildResult(item, itemId) {
  const video = item.video || {};
  const images = item.images || [];

  // 图集：目前只返回第一张，标题里说明清楚，避免误导用户
  if (!video.play_addr && images.length) {
    const first = firstUrl(images[0].url_list);
    if (!first) throw Object.assign(new Error('图集解析失败'), { code: 1002 });
    return {
      type: 'image',
      url: first,
      cover: first,
      title: (item.desc || '').slice(0, 80) + '（图集共 ' + images.length + ' 张，当前为第 1 张）',
      author: (item.author && item.author.nickname) || '',
      platform: 'douyin',
      platform_name: '抖音',
      local: false,
      extra: { item_id: itemId, image_count: images.length },
    };
  }

  const rawPlay = pickBestPlayUrl(video);
  if (!rawPlay) {
    throw Object.assign(new Error('没拿到视频地址，作品可能是图文或已被平台下架'), { code: 1002 });
  }

  return {
    type: 'video',
    // ★ 关键一步：playwm → play，拿到无水印原片
    url: toNoWatermark(rawPlay),
    cover: firstUrl(video.cover && video.cover.url_list) || firstUrl(video.origin_cover && video.origin_cover.url_list),
    title: (item.desc || '').trim(),
    author: (item.author && item.author.nickname) || '',
    platform: 'douyin',
    platform_name: '抖音',
    local: false,
    extra: {
      item_id: itemId,
      duration_ms: video.duration || 0,
      watermarked_url: rawPlay,
    },
  };
}

module.exports = { parse, pickItemId, toNoWatermark, extractRouterData, _resetToken: () => { tokenCache = { value: '', at: 0 }; } };
