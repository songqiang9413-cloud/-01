/**
 * 全局配置
 * 上线前只需要改这个文件 + 微信公众平台的域名白名单
 */

// 当前环境：dev = 本地调试（开发者工具里勾选「不校验合法域名」），prod = 线上
const ENV = 'dev';

const ENV_CONFIG = {
  dev: {
    apiBase: 'http://127.0.0.1:8000',
    // 资源中转前缀：视频/图片直链不能直接给小程序下载（域名不在白名单），统一走后端中转
    mediaProxy: 'http://127.0.0.1:8000/api/proxy?url=',
  },
  prod: {
    // 改成你自己的已备案域名（必须是 https，且在公众平台「开发管理 - 服务器域名」里配置）
    apiBase: 'https://api.your-domain.com',
    mediaProxy: 'https://api.your-domain.com/api/proxy?url=',
  },
};

const current = ENV_CONFIG[ENV];

// ---------- 微信云托管（可选，推荐）----------
// 填了 envId 就走「云托管内网专线」调用后端：不用买域名、不用备案、
// 不用在小程序后台配「request 合法域名」，外面的人也扫不到你的后端；
// 留空则用上面的 apiBase（需要自己的 https 域名，且域名要备案）。
// envId 在「微信云托管控制台 - 环境」里看，形如 prod-1gxxxxxx；
// service 是云托管里的服务名（新建服务时自己起的名字，默认常见为 server）。
const CLOUD = {
  // 2026-09 已建好的云托管环境（控制台里可以改，这里填的是当前在用的）
  envId: 'prod-d0gj2but32ea37fed',
  service: 'express-jt32',
};

module.exports = {
  env: ENV,
  apiBase: current.apiBase,
  mediaProxy: current.mediaProxy,
  cloud: CLOUD,

  // 接口超时（毫秒）：服务商公告要求短视频解析按 60 秒算，前端这里放宽到 60 秒
  requestTimeout: 60000,

  // ---------- 业务参数 ----------
  // 规则：解析免费；「保存到相册」消耗 1 次；
  //       次数只能靠看激励视频获得，看一次 +10 次，24 小时有效。
  // ★ 真正的账本在服务端（server/.env），这里只是没连上服务器时的展示兜底值。
  business: {
    // 看一次广告送几次「保存」次数
    rewardPerAd: 10,
    // 次数有效期（小时）
    validHours: 24,
    // 每人每天最多看几次广告（服务端限制）
    maxRewardPerDay: 10,
    // 每人每天的解析上限（服务端限制，防刷用，正常用户碰不到）
    parseDailyLimit: 100,
    // 连续失败多少次后提示用户
    maxRetry: 2,
  },

  // ---------- 广告位 ----------
  // 去微信公众平台「流量主 - 广告位管理」创建后，把 adunit-xxx 填到这里。
  //
  // ★ 更推荐的做法：这里什么都不用改，直接在「微信云托管 -> 环境变量」里配
  //   AD_UNIT_REWARDED / AD_UNIT_BANNER_HOME / ... ，小程序启动时会从 /api/client/config
  //   拉到服务端的值并覆盖下面的默认值 —— 好处是换广告位不用重新提交审核（提审要等好几天）。
  //   这里保留的是「服务端没配 / 还没拉到」时的兜底值，占位广告位不会真的展示广告。
  // adEnabled=false 时全部走「无广告」逻辑（开发阶段建议关掉，否则开发者工具里必报错）
  adEnabled: true,
  adUnits: {
    // banner 广告（<ad> 组件）
    bannerHome: 'adunit-0000000000000001',
    bannerResult: 'adunit-0000000000000002',
    // 激励视频广告（wx.createRewardedVideoAd）
    rewardedVideo: 'adunit-0000000000000003',
    // 插屏广告（wx.createInterstitialAd）
    interstitial: 'adunit-0000000000000004',
  },
  // 插屏广告的展示间隔（毫秒），微信本身也有限频，这里再兜一层，避免骚扰用户
  interstitialMinInterval: 60 * 1000,

  // ---------- 埋点 ----------
  tracker: {
    // 是否同时上报到微信官方「自定义分析」（需要在公众平台后台先配置事件和参数）
    officialAnalytics: false,
    // 批量上报条数阈值
    flushSize: 8,
    // 定时上报间隔（毫秒）
    flushInterval: 5000,
    // 本地最多缓存多少条事件（超出丢弃最旧的）
    maxQueue: 300,
    // 失败重试次数与退避基数（毫秒）
    maxRetry: 3,
    retryBase: 3000,
    // 是否打印埋点日志（开发阶段建议 true，方便在控制台核对）
    debug: ENV === 'dev',
  },

  // 分享文案
  share: {
    title: '清月水印处理工具｜粘贴链接就能存无水印原片',
    path: '/pages/index/index',
  },
};
