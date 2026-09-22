/**
 * 登录鉴权
 * - code2session：用 wx.login 的 code 换 openid
 * - token：自己签一个 HMAC token，省掉服务端 session 存储
 */
const config = require('./config');
const logger = require('./logger');
const { hmac, base64url, fromBase64url } = require('./utils');

function signToken(payload, ttlSeconds = config.tokenTtl) {
  const body = base64url(
    JSON.stringify(
      Object.assign({}, payload, {
        iat: Math.floor(Date.now() / 1000),
        exp: Math.floor(Date.now() / 1000) + ttlSeconds,
      })
    )
  );
  return body + '.' + hmac(body, config.tokenSecret).slice(0, 32);
}

function verifyToken(token) {
  if (!token || typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const [body, sign] = parts;
  if (hmac(body, config.tokenSecret).slice(0, 32) !== sign) return null;
  try {
    const payload = JSON.parse(fromBase64url(body));
    if (payload.exp && payload.exp < Math.floor(Date.now() / 1000)) return null;
    return payload;
  } catch (err) {
    return null;
  }
}

/**
 * 用 code 换 openid
 * 没配置 appid/secret 时进入开发模式：返回一个固定的虚拟 openid，
 * 这样本地反复联调时次数、统计都能连贯。
 */
async function code2session(code) {
  const { appId, appSecret, devOpenId } = config.wechat;
  if (!appId || !appSecret) {
    return { openid: devOpenId, dev: true };
  }
  const url =
    'https://api.weixin.qq.com/sns/jscode2session?appid=' +
    encodeURIComponent(appId) +
    '&secret=' +
    encodeURIComponent(appSecret) +
    '&js_code=' +
    encodeURIComponent(code) +
    '&grant_type=authorization_code';

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const res = await fetch(url, { signal: controller.signal });
    const data = await res.json();
    if (!data.openid) {
      logger.warn('code2session 失败:', data);
      throw Object.assign(new Error(data.errmsg || '微信登录失败'), { code: 1001 });
    }
    return { openid: data.openid, sessionKey: data.session_key, unionid: data.unionid };
  } finally {
    clearTimeout(timer);
  }
}

/** 从请求头里取当前用户；没有则返回 null（不抛错，交给业务决定是否放行） */
function currentUser(req) {
  const header = req.headers.authorization || req.headers.Authorization || '';
  const token = header.replace(/^Bearer\s+/i, '').trim();
  return verifyToken(token);
}

module.exports = { signToken, verifyToken, code2session, currentUser };
