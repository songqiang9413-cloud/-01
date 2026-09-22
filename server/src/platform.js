/**
 * 平台识别（服务端版本，和 miniprogram/utils/util.js 里的保持一致）
 */
const RULES = [
  [/douyin\.com|iesdouyin/i, 'douyin'],
  [/kuaishou\.com|gifshow|chenzhongtech/i, 'kuaishou'],
  [/xiaohongshu\.com|xhslink/i, 'xiaohongshu'],
  [/bilibili\.com|b23\.tv/i, 'bilibili'],
  [/weishi\.qq\.com|isee\.qq\.com/i, 'weishi'],
  [/ixigua\.com/i, 'ixigua'],
  [/pipix\.com|pipixia/i, 'pipixia'],
  [/huoshan|douyin\.com\/follow/i, 'huoshan'],
  [/weibo\.(com|cn)/i, 'weibo'],
  [/toutiao\.com/i, 'toutiao'],
  [/meipai\.com/i, 'meipai'],
  [/zuiyou/i, 'zuiyou'],
];

const NAMES = {
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

function detect(text) {
  const value = String(text || '');
  for (let i = 0; i < RULES.length; i += 1) {
    if (RULES[i][0].test(value)) return RULES[i][1];
  }
  return value ? 'other' : 'unknown';
}

function name(key) {
  return NAMES[key] || '其他';
}

module.exports = { detect, name, NAMES };
