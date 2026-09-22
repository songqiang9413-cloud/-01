/**
 * POST /api/auth/login
 * 用 wx.login 的 code 换 openid，并返回自定义 token
 */
const store = require('../store');
const config = require('../config');
const { code2session, signToken } = require('../auth');
const { sendOk, sendError } = require('../utils');

async function login(ctx) {
  const { body, res, req } = ctx;
  const code = body.code;
  const cloudOpenid = cloudOpenidOf(req);
  if (!code && !cloudOpenid) {
    sendError(res, 1001, '缺少 code');
    return;
  }

  let session;
  try {
    // 云托管：小程序走内网调用时平台会注入可信的 openid，直接用，连密钥都不用配
    session = cloudOpenid ? { openid: cloudOpenid, cloud: true } : await code2session(code);
  } catch (err) {
    sendError(res, 1001, err.message || '微信登录失败');
    return;
  }

  const openid = session.openid;
  const existed = store.getUserSummary(openid).first_seen > 0;
  const user = store.touchUser(openid, { uid: body.uid, platform: body.platform });

  sendOk(res, {
    token: signToken({ openid }),
    openid,
    is_new_user: !existed,
    dev_mode: !!session.dev,
    cloud_mode: !!session.cloud,
    user: {
      first_seen: user.first_seen,
      total_parse: user.total_parse || 0,
    },
    wallet: store.walletSnapshot(openid),
  });
}

/** 云托管注入的真实 openid（没走云托管 / 关掉了信任就是空） */
function cloudOpenidOf(req) {
  if (!config.cloud || !config.cloud.trustOpenid) return '';
  const raw = req && req.headers && req.headers['x-wx-openid'];
  return raw ? String(raw) : '';
}

module.exports = { login, cloudOpenidOf };
