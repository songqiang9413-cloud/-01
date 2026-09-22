/**
 * 网络通道（业务请求 + 埋点上报共用）
 * ------------------------------------------------------------------
 * 为什么单独抽出来：
 *   连后端有两条路 —— 云托管内网专线（wx.cloud.callContainer）和普通 wx.request。
 *   埋点上报原本自己直接 wx.request 打 apiBase，而线上配置里 apiBase 是 127.0.0.1，
 *   手机上的 127.0.0.1 指的是手机自己，结果真机一条埋点都发不出去：
 *   功能看着正常，UV / 计算次数 / 广告点击却全是 0。
 *   业务请求和埋点必须共用同一条通道，才不会再现「功能能用、数据全空」。
 * ------------------------------------------------------------------
 */
const gConfig = require('../config/index');

/** GET 请求的参数拼到路径上（云托管的 callContainer 不吃 wx.request 那套 data 转 query） */
function withQuery(path, data) {
  const keys = Object.keys(data || {});
  if (!keys.length) return path;
  const qs = keys
    .map((k) => encodeURIComponent(k) + '=' + encodeURIComponent(data[k]))
    .join('&');
  return path + (path.indexOf('?') > -1 ? '&' : '?') + qs;
}

/**
 * 发请求：两种通道二选一
 * - 云托管：填了 cloud.envId 就走微信内网专线（免域名、免备案）
 * - 自建服务器：普通 wx.request（需要自己的 https 域名 + 备案）
 * 两者的回调格式一样（statusCode / data），所以上层逻辑不用改。
 * @param {object} opts { url, method, data, timeout }
 */
function send(opts, header, handlers) {
  const cloud = gConfig.cloud || {};
  const timeout = opts.timeout || gConfig.requestTimeout;
  if (cloud.envId) {
    const isGet = opts.method === 'GET';
    wx.cloud.callContainer({
      config: { env: cloud.envId },
      path: isGet ? withQuery(opts.url, opts.data) : opts.url,
      method: opts.method,
      header: Object.assign({ 'X-WX-SERVICE': cloud.service || 'server' }, header),
      data: isGet ? {} : opts.data || {},
      timeout,
      success: handlers.success,
      fail: handlers.fail,
    });
    return;
  }
  wx.request({
    url: gConfig.apiBase + opts.url,
    method: opts.method,
    data: opts.data || {},
    header,
    timeout,
    success: handlers.success,
    fail: handlers.fail,
  });
}

module.exports = { send, withQuery };
