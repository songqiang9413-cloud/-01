/**
 * 埋点 SDK（自研，零依赖）
 * ------------------------------------------------------------------
 * 设计要点：
 * 1. uid（匿名设备 ID）：持久化在本地，用来算 UV / 新增用户；换设备或清缓存会重新生成。
 * 2. sid（会话 ID）：30 分钟内不重复生成；用来算使用时长、人均使用次数。
 * 3. 队列 + 批量上报：事件先入内存队列，满 flushSize 条 / 每 flushInterval 毫秒 / 关键事件立即上报。
 * 4. 失败重试 + 离线补发：上报失败的事件写进本地缓存，下次启动继续补发，避免弱网丢数据。
 * 5. 客户端时间 ts 会一起上报：服务端按 ts 归属自然日，补发的事件不会算到错误的日期。
 * ------------------------------------------------------------------
 * 用法：
 *   const tracker = require('./utils/tracker');
 *   tracker.init();                     // app.js onLaunch
 *   tracker.track('parse_submit', {...});// 任意位置
 *   tracker.pageView('pages/index/index');
 *   tracker.flush();                    // app.js onHide
 */

const gConfig = require('../config/index');
const storage = require('./storage');
const device = require('./device');
const util = require('./util');
// 上报走和业务请求同一条通道：线上 apiBase 是 127.0.0.1，
// 直接用 wx.request 打它的话真机会全军覆没（这就是 UV / 计算次数 / 广告点击全是 0 的原因）
const transport = require('./transport');

const SDK_VERSION = '1.1.0';

const KEY = {
  uid: 'track_uid',
  firstVisit: 'track_first_visit',
  sid: 'track_sid',
  sidTs: 'track_sid_ts',
  seq: 'track_seq',
  queue: 'track_queue',
  lastFlush: 'track_last_flush',
  openid: 'track_openid',
  day: 'track_day',
};

const SESSION_GAP = 30 * 60 * 1000; // 30 分钟无操作视为新会话
const MAX_EVENTS_PER_REQUEST = 50;

// 这些事件一发生就立刻上报，尽量别丢
const IMMEDIATE_EVENTS = {
  app_launch: 1,
  parse_success: 1,
  parse_fail: 1,
  ad_click: 1,
  ad_reward_success: 1,
  download_success: 1,
};

const cfg = gConfig.tracker || {};

const state = {
  inited: false,
  uid: '',
  sid: '',
  seq: 0,
  openid: '',
  queue: [],
  flushing: false,
  retry: 0,
  timer: null,
  pageEnter: {},
  currentPage: '',
  launchInfo: null,
  referrer: '',
  persistTimer: null,
};

/* ------------------------------- 基础信息 ------------------------------- */

function getUid() {
  if (state.uid) return state.uid;
  let uid = storage.get(KEY.uid, '');
  if (!uid) {
    uid = util.randomId('u_');
    storage.set(KEY.uid, uid);
    storage.set(KEY.firstVisit, Date.now());
  }
  state.uid = uid;
  return uid;
}

function getFirstVisit() {
  let ts = Number(storage.get(KEY.firstVisit, 0));
  if (!ts) {
    ts = Date.now();
    storage.set(KEY.firstVisit, ts);
  }
  return ts;
}

function getSessionId() {
  const now = Date.now();
  const last = Number(storage.get(KEY.sidTs, 0));
  if (state.sid && now - last < SESSION_GAP) {
    storage.set(KEY.sidTs, now);
    return state.sid;
  }
  state.sid = storage.get(KEY.sid, '');
  if (!state.sid || now - last >= SESSION_GAP) {
    state.sid = util.randomId('s_');
    storage.set(KEY.sid, state.sid);
  }
  storage.set(KEY.sidTs, now);
  return state.sid;
}

function nextSeq() {
  state.seq = Number(storage.get(KEY.seq, 0)) + 1;
  storage.set(KEY.seq, state.seq);
  return state.seq;
}

/** 只保留可上报的原始类型，避免把 undefined / 对象 / 超长字符串塞进埋点 */
function sanitizeProps(props) {
  const out = {};
  if (!props || typeof props !== 'object') return out;
  Object.keys(props).forEach((key) => {
    const value = props[key];
    if (value === undefined || value === null || typeof value === 'function') return;
    const type = typeof value;
    if (type === 'string') {
      out[key] = value.length > 500 ? value.slice(0, 500) : value;
    } else if (type === 'number') {
      out[key] = isFinite(value) ? value : 0;
    } else if (type === 'boolean') {
      out[key] = value;
    } else {
      try {
        out[key] = JSON.stringify(value).slice(0, 500);
      } catch (err) {
        /* 忽略无法序列化的值 */
      }
    }
  });
  return out;
}

/* ------------------------------- 上报 ------------------------------- */

function persistQueue() {
  // 只在真有数据时写盘；写盘会失败也无所谓，内存队列仍在
  storage.set(KEY.queue, state.queue.slice(-(cfg.maxQueue || 300)));
}

function schedulePersist() {
  if (state.persistTimer) return;
  state.persistTimer = setTimeout(() => {
    state.persistTimer = null;
    persistQueue();
  }, 1000);
}

function restoreQueue() {
  const saved = storage.get(KEY.queue, []);
  if (Array.isArray(saved) && saved.length) {
    state.queue = saved.concat(state.queue).slice(-(cfg.maxQueue || 300));
    storage.remove(KEY.queue);
    console.log('[tracker] 补发上次未上报的事件', saved.length, '条');
  }
}

function enqueue(event) {
  state.queue.push(event);
  const max = cfg.maxQueue || 300;
  if (state.queue.length > max) {
    state.queue = state.queue.slice(-max);
  }
  schedulePersist();
}

function send(events) {
  return new Promise((resolve, reject) => {
    const data = {
      app: Object.assign({}, device.getEnvInfo(), {
        sdk_ver: SDK_VERSION,
        user_id: state.openid || '',
        first_visit: getFirstVisit(),
      }),
      events,
    };
    transport.send(
      { url: '/api/track', method: 'POST', data, timeout: 10000 },
      { 'content-type': 'application/json' },
      {
        success(res) {
          if (res.statusCode >= 200 && res.statusCode < 300) {
            resolve(res.data || {});
            return;
          }
          reject(new Error('HTTP ' + res.statusCode));
        },
        fail(err) {
          reject(err);
        },
      }
    );
  });
}

function scheduleFlush(delay) {
  if (state.timer) return;
  state.timer = setTimeout(() => {
    state.timer = null;
    flush();
  }, delay === undefined ? cfg.flushInterval || 5000 : delay);
}

/**
 * 把队列里的事件发出去
 * @param {boolean} immediate 忽略节流，立刻发
 */
function flush(immediate) {
  if (state.flushing) return Promise.resolve(false);
  if (!state.queue.length) return Promise.resolve(true);
  if (!immediate && state.retry > 0 && state.retry >= (cfg.maxRetry || 3)) {
    // 连续失败太多次：先歇一会，避免把用户的电量和流量耗光
    scheduleFlush(30000);
    return Promise.resolve(false);
  }

  state.flushing = true;
  const batch = state.queue.slice(0, MAX_EVENTS_PER_REQUEST);

  return send(batch)
    .then(() => {
      state.flushing = false;
      state.retry = 0;
      // 只移除已经发出去的那些（期间可能又入队了新的）
      state.queue = state.queue.slice(batch.length);
      storage.set(KEY.lastFlush, Date.now());
      persistQueue();
      if (cfg.debug) console.log('[tracker] 上报成功', batch.length, '条，剩余', state.queue.length);
      if (state.queue.length) flush();
      return true;
    })
    .catch((err) => {
      state.flushing = false;
      state.retry += 1;
      persistQueue();
      if (cfg.debug) {
        console.warn('[tracker] 上报失败（第' + state.retry + '次）', err && (err.errMsg || err.message || err));
      }
      if (state.retry <= (cfg.maxRetry || 3)) {
        scheduleFlush((cfg.retryBase || 3000) * state.retry);
      }
      return false;
    });
}

/* ------------------------------- 对外 API ------------------------------- */

/**
 * 初始化，必须在 app.onLaunch 里第一个调用
 * @param {object} options { launchOptions }
 */
function init(options = {}) {
  if (state.inited) return;
  state.inited = true;

  getUid();
  getSessionId();
  state.seq = Number(storage.get(KEY.seq, 0));
  state.openid = storage.get(KEY.openid, '');

  const launch = options.launchOptions || device.getLaunchOptions() || {};
  state.launchInfo = {
    scene: launch.scene,
    query: launch.query || {},
    path: launch.path || '',
    ts: Date.now(),
  };
  state.currentPage = launch.path || 'pages/index/index';

  restoreQueue();

  track('app_launch', {
    scene: launch.scene,
    scene_name: device.sceneName(launch.scene),
    path: launch.path || '',
    query: JSON.stringify(launch.query || {}).slice(0, 300),
    from_uid: (launch.query && (launch.query.from_uid || launch.query.fu)) || '',
    from: (launch.query && launch.query.from) || '',
    cold_start: true,
    first_visit: getFirstVisit(),
  });
}

/** 登录拿到 openid 后调用，用来把「设备」和「用户」关联起来 */
function setUserId(openid) {
  if (!openid) return;
  state.openid = openid;
  storage.set(KEY.openid, openid);
}

/**
 * 上报一个事件
 * @param {string} event 事件名（见 docs/埋点方案.md）
 * @param {object} props 事件属性
 */
function track(event, props) {
  if (!event) return;
  const sid = getSessionId();
  const item = {
    e: event,
    uid: getUid(),
    sid,
    ts: Date.now(),
    seq: nextSeq(),
    p: state.currentPage || '',
    r: state.referrer || '',
    props: sanitizeProps(props),
  };
  enqueue(item);

  if (cfg.debug) console.log('[tracker]', event, item.props);

  // 双写微信官方自定义分析（可选，需要在公众平台后台先配置好事件）
  if (cfg.officialAnalytics) {
    reportOfficial(event, item.props);
  }

  if (IMMEDIATE_EVENTS[event]) {
    flush(true);
  } else if (state.queue.length >= (cfg.flushSize || 8)) {
    flush(true);
  } else {
    scheduleFlush();
  }
}

/** 微信官方自定义分析：事件名和参数需要在后台先配置，否则调用无效（不报错） */
function reportOfficial(event, props) {
  if (!wx.reportAnalytics) return;
  try {
    const data = {};
    Object.keys(props || {}).forEach((key) => {
      if (data[key] !== undefined) return;
      const value = props[key];
      if (typeof value === 'string' || typeof value === 'number') {
        data[key] = value;
      }
    });
    wx.reportAnalytics(event, data);
  } catch (err) {
    /* 官方埋点失败不影响主流程 */
  }
}

/** 页面曝光；在 Page.onShow 里调用 */
function pageView(path, props) {
  if (path) {
    state.referrer = state.currentPage && state.currentPage !== path ? state.currentPage : state.referrer;
    state.currentPage = path;
  }
  const target = path || state.currentPage;
  state.pageEnter[target] = Date.now();
  track('page_view', Object.assign({ path: target }, props || {}));
}

/** 页面离开；在 Page.onHide / onUnload 里调用，会带上停留时长 */
function pageLeave(path, props) {
  const target = path || state.currentPage;
  const enter = state.pageEnter[target];
  const stay = enter ? Date.now() - enter : 0;
  delete state.pageEnter[target];
  track(
    'page_leave',
    Object.assign(
      {
        path: target,
        stay_ms: stay,
        stay_sec: Math.round(stay / 1000),
      },
      props || {}
    )
  );
}

/** JS 异常上报 */
function captureError(err, extra) {
  const message = err && (err.message || err.errMsg || err);
  track('js_error', Object.assign({
    msg: typeof message === 'string' ? message : String(message),
    stack: err && err.stack ? String(err.stack).slice(0, 500) : '',
  }, extra || {}));
}

/** 便捷方法：给一个动作计时，返回一个函数，调用后上报带 cost_ms 的事件 */
function timer(event, props) {
  const start = Date.now();
  return function done(extra) {
    track(event, Object.assign({}, props || {}, extra || {}, { cost_ms: Date.now() - start }));
  };
}

/** 当前 uid，调试用 */
function getMeta() {
  return {
    uid: getUid(),
    sid: state.sid,
    openid: state.openid,
    queue: state.queue.length,
    retry: state.retry,
  };
}

/** 紧急上报（app.onHide 用），同步把队列写盘 */
function flushAndPersist() {
  persistQueue();
  flush(true);
}

module.exports = {
  init,
  track,
  pageView,
  pageLeave,
  setUserId,
  captureError,
  timer,
  flush: flushAndPersist,
  getMeta,
  SDK_VERSION,
};
