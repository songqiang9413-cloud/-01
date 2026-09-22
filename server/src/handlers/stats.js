/**
 * 统计接口（给数据看板和「我的」页用）
 */
const store = require('../store');
const { sendOk, dateKey } = require('../utils');

const SCENE_NAMES = {}; // 由上报数据里自带的 scene_name 填充

function mergeCount(target, source) {
  Object.keys(source || {}).forEach((key) => {
    if (typeof source[key] === 'number') {
      target[key] = (target[key] || 0) + source[key];
    }
  });
}

function summary(ctx) {
  const days = Math.min(90, Math.max(1, Number(ctx.query.days) || 14));
  const now = Date.now();
  const dates = [];
  for (let i = days - 1; i >= 0; i -= 1) {
    dates.push(dateKey(now, -i));
  }

  const series = dates.map((date) => store.dayMetrics(date));

  // 区间 UV 要按 uid 去重，不能把每天的 UV 直接相加
  const uvSet = new Set();
  const eventsTotal = {};
  const scenes = {};
  const platforms = {};
  const parseByPlatform = {};
  const hours = {};
  const adByType = {};
  const serverTotals = { parse_success: 0, parse_fail: 0, reward_granted: 0, quota_blocked: 0 };

  dates.forEach((date) => {
    const rollup = store.getRollup(date);
    Object.keys(rollup.uv).forEach((uid) => uvSet.add(uid));
    mergeCount(eventsTotal, rollup.events);
    mergeCount(scenes, rollup.scenes);
    mergeCount(platforms, rollup.platforms);
    mergeCount(parseByPlatform, rollup.parse.by_platform);
    if (rollup.scene_names) Object.assign(SCENE_NAMES, rollup.scene_names);
    Object.keys(rollup.hourly || {}).forEach((hour) => {
      const item = rollup.hourly[hour];
      if (!hours[hour]) hours[hour] = { hour: Number(hour), uv: {}, events: 0, parse: 0, ad_click: 0, page_view: 0 };
      Object.keys(item.uv || {}).forEach((uid) => {
        hours[hour].uv[uid] = 1;
      });
      hours[hour].events += item.events || 0;
      hours[hour].parse += item.parse || 0;
      hours[hour].ad_click += item.ad_click || 0;
      hours[hour].page_view += item.page_view || 0;
    });
    Object.keys(rollup.ad.by_type || {}).forEach((type) => {
      if (!adByType[type]) adByType[type] = { type, click: 0, show: 0, reward_success: 0, load_fail: 0 };
      mergeCount(adByType[type], rollup.ad.by_type[type]);
    });
    const server = rollup.server || {};
    serverTotals.parse_success += server.parse_success || 0;
    serverTotals.parse_fail += server.parse_fail || 0;
    serverTotals.reward_granted += server.reward_granted || 0;
  });

  const sum = (key) => series.reduce((acc, item) => acc + (item[key] || 0), 0);

  const rangeTotals = {
    uv: uvSet.size,
    new_users: sum('new_users'),
    page_view: sum('page_view'),
    parse_submit: sum('parse_submit'),
    parse_start: sum('parse_start'),
    parse_success: sum('parse_success'),
    parse_fail: sum('parse_fail'),
    ad_click: sum('ad_click'),
    ad_click_intent: sum('ad_click_intent'),
    ad_click_area_tap: sum('ad_click_area_tap'),
    ad_show: sum('ad_show'),
    ad_reward_success: sum('ad_reward_success'),
    ad_load_fail: sum('ad_load_fail'),
    download_start: sum('download_start'),
    download_success: sum('download_success'),
    share_click: sum('share_click'),
    new_user_from_share: sum('new_user_from_share'),
    server_parse_success: serverTotals.parse_success,
    server_parse_fail: serverTotals.parse_fail,
    reward_granted: serverTotals.reward_granted,
  };

  const today = store.dayMetrics(dateKey());

  sendOk(ctx.res, {
    generated_at: Date.now(),
    range: { days, from: dates[0], to: dates[dates.length - 1] },
    today,
    series,
    range_totals: rangeTotals,
    funnel: [
      { key: 'uv', name: '打开小程序的用户', value: uvSet.size },
      { key: 'parse_submit', name: '点击「一键去水印」', value: rangeTotals.parse_submit },
      { key: 'parse_success', name: '解析成功（客户端口径）', value: rangeTotals.parse_success },
      { key: 'download_success', name: '成功保存到相册', value: rangeTotals.download_success },
    ],
    scenes: Object.keys(scenes)
      .map((key) => ({ key, name: SCENE_NAMES[key] || '场景值 ' + key, value: scenes[key] }))
      .sort((a, b) => b.value - a.value)
      .slice(0, 12),
    platforms: Object.keys(platforms)
      .map((key) => ({
        key,
        name: require('../platform').name(key),
        value: platforms[key],
        success: parseByPlatform[key] || 0,
      }))
      .sort((a, b) => b.value - a.value)
      .slice(0, 12),
    hours: Object.keys(hours)
      .map((hour) => ({
        hour: Number(hour),
        uv: Object.keys(hours[hour].uv).length,
        events: hours[hour].events,
        parse: hours[hour].parse,
        ad_click: hours[hour].ad_click,
      }))
      .sort((a, b) => a.hour - b.hour),
    ad_by_type: Object.values(adByType),
    events_top: Object.keys(eventsTotal)
      .map((key) => ({ key, value: eventsTotal[key] }))
      .sort((a, b) => b.value - a.value)
      .slice(0, 20),
    raw_events: {
      total_users: store.userCount(),
      dates: store.listDates(),
    },
  });
}

/** 单个用户自己的汇总（「我的」页用） */
function userSummary(ctx) {
  const openid = ctx.user.openid;
  const wallet = store.walletSnapshot(openid);
  const profile = store.getUserSummary(openid);
  sendOk(ctx.res, {
    total_parse: profile.total_parse,
    today_parse: wallet.parse_today,
    today_ad: wallet.ad_times_today,
    first_seen: profile.first_seen,
    last_seen: profile.last_seen,
    wallet,
  });
}

module.exports = { summary, userSummary };
