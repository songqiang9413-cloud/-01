/**
 * 数据层（零依赖）
 * ------------------------------------------------------------------
 * 存储结构：
 *   data/events/2026-09-22.jsonl   原始事件流水（一行一条，方便导出/排查）
 *   data/rollup/2026-09-22.json    当天汇总（UV 集合、各事件计数、分平台、分小时）
 *   data/wallet.json               每个用户的「保存次数」余额 + 过期时间（看广告领的，24 小时有效）
 *   data/quota/2026-09-22.json     当天每个用户的行为计数（解析了几次、看了几次广告，用于防刷）
 *   data/users.json                用户档案（首次/最近出现、累计解析次数）
 *   data/uv_index.json             uid -> 首次出现的日期（用于算「新增用户」）
 *
 * 为什么用文件而不是数据库：单机每天几万条事件完全撑得住，零依赖、零运维，
 * 换服务器只要拷 data 目录。真到了需要数据库的量级，只需要替换这个文件。
 * ------------------------------------------------------------------
 */
const fs = require('fs');
const path = require('path');
const config = require('./config');
const logger = require('./logger');
const { dateKey, hourOf } = require('./utils');

const DIR = {
  events: path.join(config.dataDir, 'events'),
  rollup: path.join(config.dataDir, 'rollup'),
  quota: path.join(config.dataDir, 'quota'),
};
const FILE = {
  users: path.join(config.dataDir, 'users.json'),
  uvIndex: path.join(config.dataDir, 'uv_index.json'),
  wallet: path.join(config.dataDir, 'wallet.json'),
};

Object.values(DIR).forEach((dir) => fs.mkdirSync(dir, { recursive: true }));

/* ----------------------------- 通用读写 ----------------------------- */

function readJson(file, fallback) {
  try {
    if (!fs.existsSync(file)) return fallback;
    const text = fs.readFileSync(file, 'utf8');
    if (!text.trim()) return fallback;
    return JSON.parse(text);
  } catch (err) {
    logger.warn('读取失败，使用默认值:', file, err.message);
    return fallback;
  }
}

function writeJson(file, data) {
  try {
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(data), 'utf8');
    fs.renameSync(tmp, file); // 先写临时文件再重命名，避免写一半进程挂掉导致文件损坏
  } catch (err) {
    logger.error('写入失败:', file, err.message);
  }
}

function appendLine(file, line) {
  try {
    fs.appendFileSync(file, line + '\n', 'utf8');
  } catch (err) {
    logger.error('追加写入失败:', file, err.message);
  }
}

/* ----------------------------- 汇总结构 ----------------------------- */

function emptyRollup(date) {
  return {
    date,
    uv: {},
    users: {},
    events: {},
    pages: {},
    scenes: {},
    scene_names: {},
    platforms: {},
    new_users: 0,
    parse: { submit: 0, start: 0, success: 0, fail: 0, cost_ms_sum: 0, by_platform: {} },
    ad: {
      click: 0,
      click_intent: 0,
      click_area_tap: 0,
      show: 0,
      load: 0,
      load_fail: 0,
      show_fail: 0,
      close: 0,
      reward_success: 0,
      by_type: {},
    },
    // 服务端权威口径：不依赖客户端上报，用于和客户端埋点交叉验证
    server: {
      parse_success: 0,
      parse_fail: 0,
      reward_granted: 0,
      quota_blocked: 0,
      parse_downgraded: 0,
      credit_consumed: 0,
      parse_blocked: 0,
      // 服务商余额/套餐出问题导致解析失败的次数（这个数一涨，就该去充值了）
      provider_quota_exhausted: 0,
    },
    share: { click: 0, success: 0, new_user_from_share: 0 },
    download: { start: 0, success: 0, fail: 0 },
    hourly: {},
  };
}

function bump(object, key, delta = 1) {
  if (!key) return;
  object[key] = (object[key] || 0) + delta;
}

function adSlot(rollup, type) {
  const key = type || 'unknown';
  if (!rollup.ad.by_type[key]) {
    rollup.ad.by_type[key] = { click: 0, show: 0, reward_success: 0, load_fail: 0 };
  }
  return rollup.ad.by_type[key];
}

function hourlySlot(rollup, hour) {
  const key = String(hour);
  if (!rollup.hourly[key]) {
    rollup.hourly[key] = { uv: {}, events: 0, parse: 0, ad_click: 0, page_view: 0 };
  }
  return rollup.hourly[key];
}

/* ----------------------------- 内存缓存 ----------------------------- */

const rollupCache = new Map(); // date -> rollup
const quotaCache = new Map(); // date -> { openid: { parse, ad } } 当天的行为计数（防刷用）
let users = readJson(FILE.users, {});
let uvIndex = readJson(FILE.uvIndex, {});
let wallet = readJson(FILE.wallet, {}); // openid -> { credits, expires_at, updated_at }
let usersDirty = false;
let uvIndexDirty = false;
let walletDirty = false;

function getRollup(date = dateKey()) {
  if (rollupCache.has(date)) return rollupCache.get(date);
  const rollup = readJson(path.join(DIR.rollup, date + '.json'), null) || emptyRollup(date);
  // 老版本文件可能缺字段，补齐后再用
  const merged = Object.assign(emptyRollup(date), rollup);
  merged.hourly = rollup.hourly || {};
  merged.scene_names = rollup.scene_names || {};
  merged.server = Object.assign(emptyRollup(date).server, rollup.server || {});
  rollupCache.set(date, merged);
  if (rollupCache.size > 32) {
    const oldest = rollupCache.keys().next().value;
    rollupCache.delete(oldest);
  }
  return merged;
}

function getQuotaMap(date = dateKey()) {
  if (quotaCache.has(date)) return quotaCache.get(date);
  const map = readJson(path.join(DIR.quota, date + '.json'), {});
  quotaCache.set(date, map);
  if (quotaCache.size > 8) {
    const oldest = quotaCache.keys().next().value;
    quotaCache.delete(oldest);
  }
  return map;
}

/* ----------------------------- 事件写入 ----------------------------- */

/**
 * 把一个事件累加进当天汇总
 * @param {object} event { e, uid, sid, ts, p, props }
 * @param {object} app   公共参数 { user_id, ... }
 * @param {string} date  归属日期
 */
function aggregate(event, app, date) {
  const rollup = getRollup(date);
  const name = event.e;
  const props = event.props || {};
  const uid = event.uid || 'unknown';
  const hour = hourOf(event.ts);

  rollup.events[name] = (rollup.events[name] || 0) + 1;
  rollup.uv[uid] = 1;
  if (app && app.user_id) rollup.users[app.user_id] = 1;
  if (event.p) bump(rollup.pages, event.p);

  const h = hourlySlot(rollup, hour);
  h.uv[uid] = 1;
  h.events += 1;

  // 首次出现的设备 = 新增用户
  if (!uvIndex[uid]) {
    uvIndex[uid] = date;
    uvIndexDirty = true;
    rollup.new_users += 1;
    if (props.from_uid) {
      rollup.share.new_user_from_share += 1;
    }
  }

  dirtyDays.add(date);

  switch (name) {
    case 'app_launch': {
      if (props.scene !== undefined) {
        const sceneKey = String(props.scene);
        bump(rollup.scenes, sceneKey);
        // 客户端已经把场景值翻译成中文名了，这里顺手记下来，看板就不用手写映射表
        if (props.scene_name) rollup.scene_names[sceneKey] = props.scene_name;
      }
      break;
    }
    case 'parse_submit': {
      rollup.parse.submit += 1;
      break;
    }
    case 'parse_start': {
      rollup.parse.start += 1;
      bump(rollup.platforms, props.platform);
      break;
    }
    case 'parse_success': {
      rollup.parse.success += 1;
      rollup.parse.cost_ms_sum += Number(props.cost_ms) || 0;
      bump(rollup.parse.by_platform, props.platform);
      h.parse += 1;
      break;
    }
    case 'parse_fail': {
      rollup.parse.fail += 1;
      bump(rollup.platforms, props.platform);
      break;
    }
    case 'page_view': {
      h.page_view += 1;
      break;
    }
    case 'ad_click': {
      rollup.ad.click += 1;
      if (props.method === 'area_tap') rollup.ad.click_area_tap += 1;
      else rollup.ad.click_intent += 1;
      adSlot(rollup, props.ad_type).click += 1;
      h.ad_click += 1;
      break;
    }
    case 'ad_show': {
      rollup.ad.show += 1;
      adSlot(rollup, props.ad_type).show += 1;
      break;
    }
    case 'ad_load': {
      rollup.ad.load += 1;
      break;
    }
    case 'ad_load_fail': {
      rollup.ad.load_fail += 1;
      adSlot(rollup, props.ad_type).load_fail += 1;
      break;
    }
    case 'ad_show_fail': {
      rollup.ad.show_fail += 1;
      break;
    }
    case 'ad_close': {
      rollup.ad.close += 1;
      break;
    }
    case 'ad_reward_success': {
      rollup.ad.reward_success += 1;
      adSlot(rollup, props.ad_type).reward_success += 1;
      break;
    }
    case 'share_click': {
      rollup.share.click += 1;
      break;
    }
    case 'share_success': {
      rollup.share.success += 1;
      break;
    }
    case 'download_start': {
      rollup.download.start += 1;
      break;
    }
    case 'download_success': {
      rollup.download.success += 1;
      break;
    }
    case 'download_fail': {
      rollup.download.fail += 1;
      break;
    }
    default:
      break;
  }
}

/**
 * 批量写入事件（埋点入口）
 * @returns {{accepted:number, days:string[]}}
 */
function writeEvents(events, app) {
  const days = new Set();
  const lines = {};
  events.forEach((event) => {
    const ts = Number(event.ts) || Date.now();
    const date = dateKey(ts);
    days.add(date);
    aggregate(Object.assign({}, event, { ts }), app, date);
    if (!lines[date]) lines[date] = [];
    lines[date].push(
      JSON.stringify({
        t: ts,
        e: event.e,
        uid: event.uid,
        sid: event.sid,
        p: event.p,
        props: event.props,
        user: (app && app.user_id) || '',
      })
    );
  });
  Object.keys(lines).forEach((date) => {
    appendLine(path.join(DIR.events, date + '.jsonl'), lines[date].join('\n'));
  });
  scheduleFlush();
  return { accepted: events.length, days: Array.from(days) };
}

/**
 * 服务端自己记录的权威事件（不经过客户端，无法被伪造）
 * 用于核对「计算次数」这类核心指标
 */
function recordServerEvent(type, payload = {}, date = dateKey()) {
  const rollup = getRollup(date);
  if (!rollup.server) rollup.server = { parse_success: 0, parse_fail: 0, reward_granted: 0, quota_blocked: 0 };
  rollup.server[type] = (rollup.server[type] || 0) + 1;
  // 自建解析失败、降级到第三方接口的次数（这个数一涨，说明平台改版了）
  if (type === 'parse_success' && payload.downgraded) {
    rollup.server.parse_downgraded = (rollup.server.parse_downgraded || 0) + 1;
  }
  dirtyDays.add(date);
  appendLine(
    path.join(DIR.events, date + '.server.jsonl'),
    JSON.stringify(Object.assign({ t: Date.now(), type }, payload))
  );
  scheduleFlush();
}

/* ----------------------------- 延迟落盘 ----------------------------- */

const dirtyDays = new Set();
const quotaDirty = new Set();
let flushTimer = null;

function markDirty(date) {
  dirtyDays.add(date);
}

function scheduleFlush() {
  if (flushTimer) return;
  flushTimer = setTimeout(flush, 2000);
  if (flushTimer.unref) flushTimer.unref();
}

function flush() {
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  // 只写这一天有变化的数据，避免定时任务把几十个文件反复重写
  dirtyDays.forEach((date) => {
    const rollup = rollupCache.get(date);
    if (rollup) writeJson(path.join(DIR.rollup, date + '.json'), rollup);
  });
  dirtyDays.clear();

  quotaDirty.forEach((date) => {
    const map = quotaCache.get(date);
    if (map) writeJson(path.join(DIR.quota, date + '.json'), map);
  });
  quotaDirty.clear();

  if (usersDirty) {
    writeJson(FILE.users, users);
    usersDirty = false;
  }
  if (uvIndexDirty) {
    writeJson(FILE.uvIndex, uvIndex);
    uvIndexDirty = false;
  }
  if (walletDirty) {
    writeJson(FILE.wallet, wallet);
    walletDirty = false;
  }
}

/* ----------------------------- 次数钱包（保存到相册用） ----------------------------- */
/*
 * 业务规则（按需求定的）：
 *   - 解析免费，不扣次数（但有一个每日解析上限，纯粹是防刷接口费的保险丝）
 *   - 「保存到相册」消耗 1 次
 *   - 次数只能靠看激励视频获得：看一次 +rewardPerAd 次
 *   - 从领取那一刻起 rewardValidHours 小时有效，过期自动归零
 *
 * 为什么用「滚动 24 小时」而不是「每天重置」：
 *   每天重置会出现「23:59 领的 10 次，00:01 就没了」，用户会来投诉；
 *   滚动窗口对用户更友好，也是需求里说的「24 小时有效」的字面含义。
 *
 * 续领规则：没过期就累加，过期时间顺延到「最近一次领取 + 有效期」。
 */

function dayItem(openid, date = dateKey()) {
  const map = getQuotaMap(date);
  const item = map[openid] || {};
  // 老数据里这两个字段叫 used / reward，读的时候顺手兼容一下
  return {
    parse: item.parse || item.used || 0,
    ad: item.ad || item.reward || 0,
  };
}

function saveDayItem(openid, item, date = dateKey()) {
  getQuotaMap(date)[openid] = item;
  quotaDirty.add(date);
  scheduleFlush();
}

/** 取出余额，顺手处理过期（过期即视为 0） */
function liveWallet(openid) {
  const item = wallet[openid];
  if (!item) return { credits: 0, expires_at: 0 };
  if (item.expires_at && item.expires_at <= Date.now()) {
    return { credits: 0, expires_at: item.expires_at, expired: true };
  }
  return item;
}

function walletSnapshot(openid, date = dateKey()) {
  const item = liveWallet(openid);
  const day = dayItem(openid, date);
  const remainMs = Math.max(0, (item.expires_at || 0) - Date.now());
  return {
    // 剩余「保存」次数
    credits: item.credits || 0,
    // 兼容老字段名（小程序里「剩余次数」的展示统一读 remaining）
    remaining: item.credits || 0,
    expires_at: item.expires_at || 0,
    remain_hours: remainMs > 0 ? Math.ceil(remainMs / 3600000) : 0,
    remain_ms: remainMs,
    // 规则参数，客户端直接读这里的值展示文案，避免两边写死不一致
    reward_per_ad: config.business.rewardPerAd,
    valid_hours: config.business.rewardValidHours,
    ad_times_today: day.ad,
    ad_limit_per_day: config.business.maxRewardPerDay,
    parse_today: day.parse,
    parse_limit_per_day: config.business.parseDailyLimit,
  };
}

/** 看完广告领次数 */
function grantAdCredits(openid, date = dateKey()) {
  const day = dayItem(openid, date);
  if (day.ad >= config.business.maxRewardPerDay) {
    return { ok: false, reason: 'reward_limit', wallet: walletSnapshot(openid, date) };
  }

  const current = liveWallet(openid);
  const credits = (current.credits || 0) + config.business.rewardPerAd;
  const expiresAt = Date.now() + config.business.rewardValidHours * 3600000;
  wallet[openid] = { credits, expires_at: expiresAt, updated_at: Date.now() };
  walletDirty = true;

  day.ad += 1;
  saveDayItem(openid, day, date);
  return {
    ok: true,
    added: config.business.rewardPerAd,
    wallet: walletSnapshot(openid, date),
  };
}

/** 保存前扣 1 次 */
function consumeCredit(openid, date = dateKey()) {
  const item = liveWallet(openid);
  if ((item.credits || 0) <= 0) {
    return { ok: false, reason: 'no_credit', wallet: walletSnapshot(openid, date) };
  }
  wallet[openid] = Object.assign({}, wallet[openid], {
    credits: item.credits - 1,
    updated_at: Date.now(),
  });
  walletDirty = true;
  scheduleFlush();
  const snapshot = walletSnapshot(openid, date);
  recordServerEvent('credit_consumed', { openid, left: snapshot.credits }, date);
  return { ok: true, wallet: snapshot };
}

/** 解析是否还在今天的防刷上限内 */
function canParseToday(openid, date = dateKey()) {
  return dayItem(openid, date).parse < config.business.parseDailyLimit;
}

/** 记一次解析（只用于防刷，不影响用户余额） */
function countParse(openid, date = dateKey()) {
  const day = dayItem(openid, date);
  day.parse += 1;
  saveDayItem(openid, day, date);
}

/* ----------------------------- 用户 ----------------------------- */

function touchUser(openid, extra = {}) {
  if (!openid) return null;
  const now = Date.now();
  const user = users[openid] || { openid, first_seen: now, total_parse: 0 };
  user.last_seen = now;
  if (extra.uid) user.uid = extra.uid;
  if (extra.platform) user.platform = extra.platform;
  users[openid] = user;
  usersDirty = true;
  scheduleFlush();
  return user;
}

function addUserParse(openid) {
  if (!openid) return;
  const user = touchUser(openid);
  user.total_parse = (user.total_parse || 0) + 1;
  usersDirty = true;
}

function getUserSummary(openid) {
  const user = users[openid] || {};
  const rollup = getRollup();
  return {
    first_seen: user.first_seen || 0,
    last_seen: user.last_seen || 0,
    total_parse: user.total_parse || 0,
    today_parse: 0,
    is_new_today: (uvIndex[user.uid] || '') === dateKey(),
    today_uv: Object.keys(rollup.uv).length,
  };
}

function userCount() {
  return Object.keys(users).length;
}

/* ----------------------------- 汇总查询 ----------------------------- */

function listDates() {
  try {
    return fs
      .readdirSync(DIR.rollup)
      .filter((f) => f.endsWith('.json'))
      .map((f) => f.replace('.json', ''))
      .sort();
  } catch (err) {
    return [];
  }
}

/** 某天的精简指标 */
function dayMetrics(date) {
  const rollup = getRollup(date);
  return {
    date,
    uv: Object.keys(rollup.uv).length,
    users: Object.keys(rollup.users).length,
    new_users: rollup.new_users || 0,
    page_view: rollup.events.page_view || 0,
    parse_submit: rollup.parse.submit,
    parse_start: rollup.parse.start,
    parse_success: rollup.parse.success,
    parse_fail: rollup.parse.fail,
    parse_success_rate:
      rollup.parse.start > 0 ? Number((rollup.parse.success / rollup.parse.start).toFixed(4)) : 0,
    parse_avg_ms:
      rollup.parse.success > 0 ? Math.round(rollup.parse.cost_ms_sum / rollup.parse.success) : 0,
    ad_click: rollup.ad.click,
    ad_click_intent: rollup.ad.click_intent,
    ad_click_area_tap: rollup.ad.click_area_tap,
    ad_show: rollup.ad.show,
    ad_reward_success: rollup.ad.reward_success,
    ad_load_fail: rollup.ad.load_fail,
    download_start: rollup.download.start,
    download_success: rollup.download.success,
    share_click: rollup.share.click,
    new_user_from_share: rollup.share.new_user_from_share,
    server_parse_success: (rollup.server && rollup.server.parse_success) || 0,
    server_parse_fail: (rollup.server && rollup.server.parse_fail) || 0,
    parse_downgraded: (rollup.server && rollup.server.parse_downgraded) || 0,
    reward_granted: (rollup.server && rollup.server.reward_granted) || 0,
    // 「保存」消耗掉的次数（服务端权威口径，和客户端 download_success 对照看）
    credit_consumed: (rollup.server && rollup.server.credit_consumed) || 0,
    // 解析撞上每日防刷上限被拦的次数
    parse_blocked: (rollup.server && rollup.server.parse_blocked) || 0,
    // 服务商点数不足 / 套餐过期导致解析失败的次数（>0 就该去服务商那边充值了）
    provider_quota_exhausted: (rollup.server && rollup.server.provider_quota_exhausted) || 0,
  };
}

module.exports = {
  DIR,
  FILE,
  getRollup,
  writeEvents,
  recordServerEvent,
  flush,
  walletSnapshot,
  grantAdCredits,
  consumeCredit,
  canParseToday,
  countParse,
  touchUser,
  addUserParse,
  getUserSummary,
  userCount,
  listDates,
  dayMetrics,
  dateKey,
};
