/**
 * GET /api/client/config —— 小程序启动时拉一次的下发配置
 * ------------------------------------------------------------------
 * 为什么要有这个接口（而不是把广告位写死在小程序里）：
 *   1) 广告位 ID 必须等「流量主」开通后才有，而小程序改一行代码都要重新提交审核（等好几天）。
 *      放服务端 = 在云托管控制台加个环境变量、重新发布，所有用户立刻生效，不用提审。
 *   2) 「看一次广告送几次」「多久过期」这类规则本来就是服务端说了算，让客户端读同一份配置，
 *      就不会出现「文案写过期 24 小时、实际算的是 12 小时」这种对不上的情况。
 *
 * 注意：这里只下发「公开信息」，没有任何密钥。
 */
const config = require('../config');
const { sendOk } = require('../utils');

function clientConfig(ctx) {
  const ad = config.ad;
  sendOk(ctx.res, {
    // false = 客户端整个广告逻辑走「无广告」分支（保存不消耗次数）
    ad_enabled: ad.enabled,
    // 空字符串表示「服务端没配」，客户端保留自己 config/index.js 里的默认值
    ad_units: {
      banner_home: ad.units.bannerHome,
      banner_result: ad.units.bannerResult,
      rewarded_video: ad.units.rewardedVideo,
      interstitial: ad.units.interstitial,
    },
    ad_interstitial_min_interval: ad.interstitialMinInterval,
    // 业务规则参数（客户端只用来展示文案，真正的判定在服务端）
    business: {
      reward_per_ad: config.business.rewardPerAd,
      valid_hours: config.business.rewardValidHours,
      max_reward_per_day: config.business.maxRewardPerDay,
      parse_daily_limit: config.business.parseDailyLimit,
    },
    server_time: Date.now(),
  });
}

module.exports = { clientConfig };
