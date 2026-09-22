/**
 * 通用小工具
 */

function pad(n) {
  n = String(n);
  return n.length > 1 ? n : '0' + n;
}

/** 2026/09/22 */
function formatDate(date = new Date(), separator = '/') {
  return [date.getFullYear(), date.getMonth() + 1, date.getDate()].map(pad).join(separator);
}

/** 20260922 */
function dateKey(date = new Date()) {
  return [date.getFullYear(), date.getMonth() + 1, date.getDate()].map(pad).join('');
}

/** 2026/09/22 10:20:30 */
function formatTime(date = new Date()) {
  return (
    formatDate(date) + ' ' + [date.getHours(), date.getMinutes(), date.getSeconds()].map(pad).join(':')
  );
}

/** 1243 -> 1.2k */
function shortNumber(num) {
  num = Number(num) || 0;
  if (num < 1000) return String(num);
  if (num < 10000) return (num / 1000).toFixed(1) + 'k';
  return (num / 10000).toFixed(1) + 'w';
}

function randomId(prefix = '') {
  return (
    prefix +
    Date.now().toString(36) +
    Math.random().toString(36).slice(2, 10)
  );
}

/** 毫秒 -> 1分23秒 */
function formatDuration(ms) {
  const total = Math.max(0, Math.round((Number(ms) || 0) / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return m > 0 ? m + '分' + s + '秒' : s + '秒';
}

/** 从一段分享文案里把链接抠出来 */
const URL_REG = /(https?:\/\/[^\s\u4e00-\u9fa5"'\u3002\uff0c\uff01\uff1f,]+)/i;
function extractUrl(text) {
  if (!text) return '';
  const match = String(text).match(URL_REG);
  return match ? match[1] : '';
}

function isUrl(text) {
  return !!extractUrl(text);
}

/** 根据分享链接判断来自哪个平台，用于埋点维度 */
function detectPlatform(text) {
  const url = String(text || '').toLowerCase();
  if (!url) return 'unknown';
  if (url.indexOf('douyin.com') > -1 || url.indexOf('iesdouyin') > -1) return 'douyin';
  if (url.indexOf('kuaishou.com') > -1 || url.indexOf('gifshow') > -1) return 'kuaishou';
  if (url.indexOf('xiaohongshu.com') > -1 || url.indexOf('xhslink') > -1) return 'xiaohongshu';
  if (url.indexOf('bilibili.com') > -1 || url.indexOf('b23.tv') > -1) return 'bilibili';
  if (url.indexOf('weishi') > -1) return 'weishi';
  if (url.indexOf('ixigua.com') > -1) return 'ixigua';
  if (url.indexOf('pipix.com') > -1) return 'pipixia';
  if (url.indexOf('huoshan') > -1) return 'huoshan';
  if (url.indexOf('weibo.com') > -1 || url.indexOf('weibo.cn') > -1) return 'weibo';
  if (url.indexOf('toutiao.com') > -1) return 'toutiao';
  if (url.indexOf('meipai.com') > -1) return 'meipai';
  if (url.indexOf('zuiyou') > -1) return 'zuiyou';
  return 'other';
}

const PLATFORM_NAME = {
  douyin: '抖音',
  kuaishou: '快手',
  xiaohongshu: '小红书',
  bilibili: '哔哩哔哩',
  weishi: '微视',
  ixigua: '西瓜视频',
  pipixia: '皮皮虾',
  huoshan: '火山',
  weibo: '微博',
  toutiao: '今日头条',
  meipai: '美拍',
  zuiyou: '最右',
  other: '其他',
  unknown: '未知',
};

function platformName(key) {
  return PLATFORM_NAME[key] || '其他';
}

module.exports = {
  formatDate,
  dateKey,
  formatTime,
  shortNumber,
  randomId,
  formatDuration,
  extractUrl,
  isUrl,
  detectPlatform,
  platformName,
  PLATFORM_NAME,
};
