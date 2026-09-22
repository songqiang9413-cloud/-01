/**
 * 配置：优先级 环境变量 > .env 文件 > 默认值
 * 不引入 dotenv，自己解析一下就够了，省掉一个依赖
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const DATA_DIR = path.join(ROOT, 'data');

function loadEnvFile(file) {
  if (!fs.existsSync(file)) return;
  fs.readFileSync(file, 'utf8')
    .split(/\r?\n/)
    .forEach((line) => {
      const text = line.trim();
      if (!text || text.startsWith('#')) return;
      const idx = text.indexOf('=');
      if (idx < 1) return;
      const key = text.slice(0, idx).trim();
      let value = text.slice(idx + 1).trim();
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      if (process.env[key] === undefined) process.env[key] = value;
    });
}

loadEnvFile(path.join(ROOT, '.env'));

function num(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function bool(value, fallback) {
  if (value === undefined || value === '') return fallback;
  return value === '1' || String(value).toLowerCase() === 'true';
}

function json(value, fallback) {
  if (!value) return fallback;
  try {
    return JSON.parse(value);
  } catch (err) {
    console.warn('[config] 无法解析 JSON：', String(value).slice(0, 80));
    return fallback;
  }
}

/**
 * 读「直连域名白名单」文件：一行一个域名，# 开头是注释。
 * 为什么要单独放文件：服务商给的 CDN 域名可能有几百个，塞进 .env 一行太长，
 * 直接粘成文本更好维护（微信后台 downloadFile 合法域名上限是 200 个）。
 * 允许直接粘完整网址，也允许写 *.xxx.com 这种通配后缀。
 */
function readHostList(file) {
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, 'utf8')
    .split(/\r?\n/)
    .map((line) => line.trim().toLowerCase())
    .filter((line) => line && !line.startsWith('#'))
    .map((line) => line.replace(/^https?:\/\//, '').replace(/\/.*$/, '').replace(/^\./, ''))
    .filter(Boolean);
}

const config = {
  root: ROOT,
  dataDir: DATA_DIR,
  envFile: path.join(ROOT, '.env'),
  port: num(process.env.PORT, 8000),
  host: process.env.HOST || '0.0.0.0',

  wechat: {
    appId: process.env.WX_APPID || '',
    appSecret: process.env.WX_SECRET || '',
    // 开发模式的固定虚拟 openid：不填 appid 时所有请求都用它，方便本地反复联调
    devOpenId: process.env.DEV_OPENID || 'dev_openid_local',
  },

  tokenSecret: process.env.TOKEN_SECRET || 'dev-token-secret',
  tokenTtl: num(process.env.TOKEN_TTL, 30 * 24 * 3600), // 秒
  adminToken: process.env.ADMIN_TOKEN || 'admin123',

  business: {
    // 解析免费，这里是每日解析的防刷上限（防止有人拿你的服务器刷接口费，不是给用户看的门槛）
    parseDailyLimit: num(process.env.PARSE_DAILY_LIMIT, 100),
    // 看一次激励视频广告，送几次「保存到相册」次数
    rewardPerAd: num(process.env.REWARD_PER_AD, 10),
    // 奖励的有效期（小时）：24 = 领取后 24 小时内有效
    rewardValidHours: num(process.env.REWARD_VALID_HOURS, 24),
    // 每天最多看几次广告（防刷上限）
    maxRewardPerDay: num(process.env.MAX_REWARD_PER_DAY, 10),
  },

  parse: {
    provider: (process.env.PARSE_PROVIDER || 'mock').toLowerCase(),
    // 主服务商失败时自动降级到它（推荐 selfhosted + http 的组合：省钱且稳定）
    fallbackProvider: (process.env.PARSE_FALLBACK_PROVIDER || '').toLowerCase(),
    apiUrl: process.env.PARSE_API_URL || '',
    apiMethod: (process.env.PARSE_API_METHOD || 'POST').toUpperCase(),
    apiHeaders: json(process.env.PARSE_API_HEADERS, {}),
    apiBody: process.env.PARSE_API_BODY || '{"url":"{url}"}',
    fields: {
      video: process.env.PARSE_FIELD_VIDEO || 'data.url',
      cover: process.env.PARSE_FIELD_COVER || 'data.cover',
      title: process.env.PARSE_FIELD_TITLE || 'data.title',
      author: process.env.PARSE_FIELD_AUTHOR || 'data.author',
      type: process.env.PARSE_FIELD_TYPE || 'data.type',
      // 图集：没有视频直链时，从这里取一组图，用第 1 张兜底
      images: process.env.PARSE_FIELD_IMAGES || 'data.images',
    },
    // 服务商（大圣API）公告要求：短视频解析超时设成 60 秒，解析失败会自动重试到超时
    timeout: num(process.env.PARSE_TIMEOUT, 60000),
  },

  proxy: {
    sign: bool(process.env.PROXY_SIGN, true),
    // 中转只允许这些主机（留空 = 不限制主机，但仍会拦截内网地址，防 SSRF）
    allowHosts: (process.env.PROXY_ALLOW_HOSTS || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    // 本地联调时可以打开，让中转允许访问 127.0.0.1（线上千万不要开）
    allowPrivate: bool(process.env.PROXY_ALLOW_PRIVATE, false),
    // 拉上游资源的「空闲」超时：60 秒内没来新数据才断开，正常下载不会受影响
    timeout: num(process.env.PROXY_TIMEOUT, 60000),
    maxBytes: num(process.env.PROXY_MAX_BYTES, 200 * 1024 * 1024),
    // 直连白名单：命中的域名直接把 CDN 原链给小程序（不花你的服务器带宽），
    // 不在名单里的统一走中转。默认空 = 全部走中转（最省事）。
    // 来源：.env 的 PROXY_DIRECT_HOSTS + data/direct-hosts.txt
    directHosts: (process.env.PROXY_DIRECT_HOSTS || '')
      .split(/[,\s]+/)
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean)
      .concat(readHostList(path.join(DATA_DIR, 'direct-hosts.txt'))),
  },

  // 微信云托管相关开关
  cloud: {
    // 云托管会把 -真- openid 放在请求头 x-wx-openid 里（只有小程序通过内网调用时才有），
    // 有这个头就不需要 WX_APPID/WX_SECRET 了。生产建议把云托管的「公网访问」关掉，
    // 万一要开着又担心别人伪造这个头，这里改成 0，然后老老实实配 WX_SECRET。
    trustOpenid: bool(process.env.TRUST_CLOUD_OPENID, true),
  },

  // 简单的频率限制
  rateLimit: {
    api: { windowMs: 60 * 1000, max: 300 },
    parse: { windowMs: 60 * 1000, max: 30 },
    track: { windowMs: 60 * 1000, max: 60 },
  },
};

module.exports = config;
