/**
 * POST /api/parse  解析链接
 * GET  /api/quota  查询剩余次数
 * POST /api/quota/reward  看广告后领取奖励次数
 * POST /api/credit/consume 保存前扣 1 次
 */
const config = require('../config');
const store = require('../store');
const logger = require('../logger');
const providers = require('../providers');
const { sendOk, sendError, hmac } = require('../utils');

// 用户经常把整段分享文案一起发过来（"7.15 复制打开抖音… https://v.douyin.com/xxx/"），
// 所以是从文本里抠出第一个链接，而不是要求整串必须就是一个链接
const URL_RE = /https?:\/\/[^\s\u4e00-\u9fa5"'。”，！？]+/i;

/**
 * 中转地址带签名，客户端必须原样使用服务端下发的这一串，
 * 自己拿 mediaProxy + url 拼出来的地址会被 403 拦掉。
 */
function buildProxyUrl(rawUrl, baseUrl) {
  if (!config.proxy.sign) {
    return baseUrl + '/api/proxy?url=' + encodeURIComponent(rawUrl);
  }
  const sign = hmac(rawUrl, config.tokenSecret).slice(0, 16);
  return baseUrl + '/api/proxy?url=' + encodeURIComponent(rawUrl) + '&s=' + sign;
}

/** 这个素材域名是不是「直连白名单」里的（白名单里的不用中转，省服务器带宽） */
function isDirectHost(rawUrl) {
  const rules = config.proxy.directHosts;
  if (!rules.length) return false;
  // 写一个 * 表示「全部直连」：云托管这类没有公网下载域名的场景要用（中转只能当兜底）
  if (rules.indexOf('*') > -1) return true;
  let host = '';
  try {
    host = new URL(rawUrl).hostname.toLowerCase();
  } catch (err) {
    return false;
  }
  return rules.some((rule) =>
    rule.indexOf('*.') === 0 ? host === rule.slice(2) || host.endsWith(rule.slice(1)) : host === rule
  );
}

async function parse(ctx) {
  const { body, res, user, baseUrl } = ctx;
  const input = String(body.url || '').trim();

  if (!input) {
    sendError(res, 1001, '请先粘贴链接');
    return;
  }
  if (input.length > 2000) {
    sendError(res, 1001, '链接太长了');
    return;
  }
  const matched = input.match(URL_RE);
  if (!matched) {
    sendError(res, 1001, '没识别到合法的链接，请复制完整的分享文案');
    return;
  }
  const target = matched[0];

  const openid = user.openid;
  // 解析不扣次数（次数只花在「保存到相册」上），但有个每日上限防止有人刷我们的接口费
  if (!store.canParseToday(openid)) {
    store.recordServerEvent('parse_blocked', { openid, reason: 'daily_limit' });
    sendError(res, 1005, '今天解析得有点多啦，明天再来吧');
    return;
  }

  const started = Date.now();
  try {
    const result = await providers.parse({ url: target, baseUrl });
    const cost = Date.now() - started;

    // ★ 服务端权威的「计算次数」：只有真的解析成功才 +1
    store.countParse(openid);
    store.addUserParse(openid);
    store.recordServerEvent('parse_success', {
      platform: result.platform,
      cost_ms: cost,
      openid,
      provider: result.provider || '',
      // 自建解析失败、靠第三方兜底成功时会带上这个标记
      downgraded: result.downgraded ? 1 : 0,
    });

    sendOk(res, {
      request_id: 'r_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8),
      type: result.type,
      url: result.url,
      // 封面图：白名单里能直连就直连（云托管没有公网下载域名，只能靠直连），
      // 否则走中转（图片只有几十 KB，不吃多少流量）
      cover: result.local || !result.cover
        ? result.cover
        : isDirectHost(result.cover)
          ? result.cover
          : buildProxyUrl(result.cover, baseUrl),
      title: result.title,
      author: result.author,
      platform: result.platform,
      platform_name: result.platform_name,
      // 中转地址（带签名）：永远返回，作为兜底
      proxy_url: result.local ? result.url : buildProxyUrl(result.url, baseUrl),
      // 直连地址：只有在「合法域名白名单」里才给，客户端优先用它（不花服务器带宽），
      // 下载失败会自动回退到上面的中转地址，所以白名单没配全也不会影响用户
      direct_url: !result.local && isDirectHost(result.url) ? result.url : '',
      provider: result.provider || '',
      cost_ms: cost,
      wallet: store.walletSnapshot(openid),
    });
  } catch (err) {
    logger.warn('解析失败:', target.slice(0, 120), err.message, err.raw ? '| raw: ' + err.raw : '');
    // 服务商点数用完 / 套餐过期：这是运营事故，不是用户的错，单独记一笔好让看板提醒
    if (err.providerQuota) {
      store.recordServerEvent('provider_quota_exhausted', { openid, msg: err.raw || '' });
    }
    store.recordServerEvent('parse_fail', {
      platform: require('../platform').detect(target),
      msg: err.message,
      code: err.code || 1002,
      openid,
    });
    sendError(res, err.code || 1002, err.message || '解析失败，请稍后重试');
  }
}

function quota(ctx) {
  sendOk(ctx.res, store.walletSnapshot(ctx.user.openid));
}

function reward(ctx) {
  const { body, res, user } = ctx;
  const result = store.grantAdCredits(user.openid);
  if (!result.ok) {
    sendError(res, 1004, '今天看广告的次数已经用完啦，明天再来');
    return;
  }
  store.recordServerEvent('reward_granted', {
    openid: user.openid,
    scene: body.scene || '',
    ad_type: body.ad_type || '',
    added: result.added,
  });
  sendOk(res, { added: result.added, valid_hours: result.wallet.valid_hours, wallet: result.wallet });
}

/**
 * 保存前扣 1 次
 * 注意：这里是唯一扣次数的地方。客户端只是「先问一下够不够」，
 * 真正的账本在服务端，改前端绕不过去。
 */
function consume(ctx) {
  const { body, res, user } = ctx;
  const result = store.consumeCredit(user.openid);
  if (!result.ok) {
    sendError(res, 1003, '保存次数用完了，看个广告就能继续保存');
    return;
  }
  sendOk(res, {
    scene: body.scene || '',
    media_type: body.media_type || '',
    wallet: result.wallet,
  });
}

module.exports = { parse, quota, reward, consume, buildProxyUrl };
