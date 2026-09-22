/**
 * POST /api/track  埋点批量上报
 * 客户端 tracker.js 会把事件攒成一批发过来，这里做校验后落盘并汇总。
 */
const store = require('../store');
const logger = require('../logger');
const { sendOk, sendError } = require('../utils');

const MAX_EVENTS = 50;
const ALLOWED_EVENT_LEN = 64;

function cleanProps(props) {
  if (!props || typeof props !== 'object') return {};
  const out = {};
  let count = 0;
  Object.keys(props).forEach((key) => {
    if (count >= 30) return;
    const value = props[key];
    const type = typeof value;
    if (type === 'string') {
      out[key] = value.length > 500 ? value.slice(0, 500) : value;
    } else if (type === 'number' && isFinite(value)) {
      out[key] = value;
    } else if (type === 'boolean') {
      out[key] = value;
    } else {
      return;
    }
    count += 1;
  });
  return out;
}

function track(ctx) {
  const { body, res, user } = ctx;
  const list = Array.isArray(body.events) ? body.events : [];
  if (!list.length) {
    sendOk(res, { accepted: 0 });
    return;
  }
  if (list.length > MAX_EVENTS) {
    sendError(res, 1001, '单次上报事件过多');
    return;
  }

  const app = body.app && typeof body.app === 'object' ? body.app : {};
  // 以 token 里的 openid 为准，客户端传的不信
  if (user && user.openid) app.user_id = user.openid;

  const events = [];
  list.forEach((item) => {
    if (!item || typeof item !== 'object') return;
    const name = String(item.e || '').slice(0, ALLOWED_EVENT_LEN);
    if (!name) return;
    events.push({
      e: name,
      uid: String(item.uid || '').slice(0, 64),
      sid: String(item.sid || '').slice(0, 64),
      ts: Number(item.ts) || Date.now(),
      seq: Number(item.seq) || 0,
      p: String(item.p || '').slice(0, 128),
      props: cleanProps(item.props),
    });
  });

  try {
    const result = store.writeEvents(events, app);
    sendOk(res, { accepted: result.accepted });
  } catch (err) {
    logger.error('埋点写入失败', err);
    sendError(res, 500, '埋点写入失败');
  }
}

module.exports = { track };
