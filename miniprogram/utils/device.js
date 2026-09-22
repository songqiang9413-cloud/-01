/**
 * 设备 / 启动参数兼容层
 * 基础库 2.20.1 起 wx.getSystemInfoSync 被拆成 getDeviceInfo / getAppBaseInfo / getWindowInfo，
 * 新版接口在旧基础库上不存在，所以这里做一层兼容，避免取不到值。
 */

const cache = {};

function safeCall(fn, fallback) {
  try {
    const res = fn();
    return res && typeof res === 'object' ? res : fallback;
  } catch (err) {
    return fallback;
  }
}

/** 一次性拿到埋点需要的全部环境信息 */
function getEnvInfo() {
  if (cache.envInfo) return cache.envInfo;

  const account = safeCall(() => wx.getAccountInfoSync(), {});
  const miniProgram = account.miniProgram || {};

  let base = safeCall(() => (wx.getAppBaseInfo ? wx.getAppBaseInfo() : null), null);
  let device = safeCall(() => (wx.getDeviceInfo ? wx.getDeviceInfo() : null), null);
  let windowInfo = safeCall(() => (wx.getWindowInfo ? wx.getWindowInfo() : null), null);

  // 旧基础库兜底
  if (!base || !device) {
    const legacy = safeCall(() => wx.getSystemInfoSync(), {});
    base = base || legacy;
    device = device || legacy;
    windowInfo = windowInfo || legacy;
  }

  cache.envInfo = {
    // 小程序
    app_id: miniProgram.appId || '',
    app_version: miniProgram.version || 'dev',
    env_version: miniProgram.envVersion || 'develop', // develop / trial / release
    // 基础库 & 微信
    sdk_version: (base && base.SDKVersion) || '',
    wx_version: (base && base.version) || '',
    language: (base && base.language) || '',
    theme: (base && base.theme) || '',
    // 设备
    platform: (device && device.platform) || '', // ios / android / devtools / windows / mac
    system: (device && device.system) || '',
    brand: (device && device.brand) || '',
    model: (device && device.model) || '',
    // 屏幕
    window_width: (windowInfo && windowInfo.windowWidth) || 0,
    window_height: (windowInfo && windowInfo.windowHeight) || 0,
    pixel_ratio: (windowInfo && windowInfo.pixelRatio) || 0,
    status_bar_height: (windowInfo && windowInfo.statusBarHeight) || 0,
  };
  return cache.envInfo;
}

/**
 * 微信官方场景值 -> 可读名称（节选常用值）
 * 完整列表见 https://developers.weixin.qq.com/miniprogram/dev/reference/scene-list.html
 * 没收录的会返回「场景值 xxx」，不影响统计，只是看板里显示得不好看
 */
const SCENE_MAP = {
  1001: '发现栏小程序主入口',
  1005: '顶部搜索框的搜索结果页',
  1006: '发现栏小程序主入口搜索框的搜索结果页',
  1007: '单人聊天会话中的小程序消息卡片',
  1008: '群聊会话中的小程序消息卡片',
  1011: '扫描二维码',
  1012: '长按图片识别二维码',
  1013: '扫描手机相册中选取的二维码',
  1014: '小程序订阅消息',
  1017: '前往小程序体验版的入口页',
  1019: '微信钱包',
  1020: '公众号 profile 页相关小程序列表',
  1022: '聊天顶部置顶小程序入口',
  1023: '安卓系统桌面图标',
  1024: '小程序 profile 页',
  1025: '扫描一维码',
  1026: '附近小程序列表',
  1027: '顶部搜索框搜索结果页「使用过的小程序」列表',
  1028: '我的卡包',
  1029: '卡券详情页',
  1030: '自动化测试下打开小程序',
  1035: '公众号自定义菜单',
  1036: 'App 分享消息卡片',
  1037: '小程序打开小程序',
  1038: '从另一个小程序返回',
  1039: '插件打开',
  1042: '添加好友搜索框的搜索结果页',
  1043: '公众号模板消息',
  1044: '带 shareTicket 的小程序消息卡片',
  1047: '扫描小程序码',
  1048: '长按图片识别小程序码',
  1049: '手机相册选取小程序码',
  1052: '卡券的适用门店列表',
  1053: '搜一搜的结果页',
  1054: '顶部搜索框小程序快捷入口',
  1056: '音乐播放器菜单',
  1058: '公众号文章',
  1059: '体验版小程序绑定邀请页',
  1064: '微信连 Wi-Fi 状态栏',
  1067: '公众号文章广告',
  1068: '附近小程序列表广告',
  1069: '移动应用通过 openSDK 打开小程序',
  1071: '钱包中的银行卡列表页',
  1072: '二维码收款页面',
  1073: '客服消息列表下发的小程序消息卡片',
  1074: '公众号会话下发的模板消息卡片',
  1077: '摇周边',
  1078: '连 Wi-Fi 成功页',
  1079: '微信游戏中心',
  1081: '客服消息列表下发的小程序消息卡片',
  1082: '视频号',
  1084: '视频号直播',
  1085: '群工具',
  1086: '聊天素材小程序打开',
  1088: '聊天记录',
  1089: '左滑删除',
  1090: '智能推荐',
  1091: '收藏',
  1092: '微信聊天主界面下拉「最近使用」',
  1093: '微信聊天主界面下拉「我的小程序」',
  1096: '聊天记录',
  1099: '微信聊天主界面下拉',
  1100: '长按小程序右上角菜单唤出最近使用历史',
  1101: '公众号文章商品卡片',
  1102: '城市服务入口',
  1104: '小程序广告组件',
  1113: '聊天记录',
  1114: '小程序订单中心页搜索',
  1124: '带 shareTicket 的小程序消息卡片',
  1125: '聊天记录',
  1129: '微信聊天主界面下拉',
  1131: '长按小程序右上角菜单唤出最近使用历史',
  1132: '视频号直播',
  1135: '微信广告',
  1136: '小程序直播',
  1144: '视频号',
  1145: '视频号直播',
  1146: '聊天',
  1147: '聊天主界面下拉',
  1148: '聊天记录',
  1150: '微信广告',
  1151: '微信广告',
  1152: '聊天',
  1153: '收藏',
  1154: '微信广告',
  1155: '微信广告',
  1156: '聊天记录',
  1157: '视频号直播',
  1158: '视频号',
  1162: '发现页-小程序',
  1165: '聊天',
  1183: '公众号',
};

function sceneName(scene) {
  if (scene === undefined || scene === null || scene === '') return '未知';
  const key = String(scene);
  return SCENE_MAP[key] || '场景值 ' + key;
}

/** 冷启动参数（小程序被打开时的入口信息） */
function getLaunchOptions() {
  return safeCall(() => wx.getLaunchOptionsSync(), {}) || {};
}

/** 热启动参数（从后台切回来、或点分享卡片再次进入） */
function getEnterOptions() {
  const res = safeCall(() => (wx.getEnterOptionsSync ? wx.getEnterOptionsSync() : null), null);
  return res || getLaunchOptions();
}

function clearCache() {
  cache.envInfo = null;
}

module.exports = { getEnvInfo, getLaunchOptions, getEnterOptions, sceneName, SCENE_MAP, clearCache };
