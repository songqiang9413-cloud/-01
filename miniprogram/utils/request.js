/**
 * 网络请求封装
 * - 自动带上登录 token
 * - 401 自动重新登录并重试一次
 * - 统一错误文案
 */
const gConfig = require('../config/index');
const storage = require('./storage');
const tracker = require('./tracker');

let reloginPromise = null;

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
 */
function send(opts, header, handlers) {
  const cloud = gConfig.cloud || {};
  if (cloud.envId) {
    const isGet = opts.method === 'GET';
    wx.cloud.callContainer({
      config: { env: cloud.envId },
      path: isGet ? withQuery(opts.url, opts.data) : opts.url,
      method: opts.method,
      header: Object.assign({ 'X-WX-SERVICE': cloud.service || 'server' }, header),
      data: isGet ? {} : opts.data || {},
      timeout: gConfig.requestTimeout,
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
    timeout: gConfig.requestTimeout,
    success: handlers.success,
    fail: handlers.fail,
  });
}

function getToken() {
  return storage.get('token', '');
}

function setToken(token) {
  if (token) {
    storage.set('token', token);
  } else {
    storage.remove('token');
  }
}

/**
 * @param {object} options { url, method, data, header, needAuth, retryOn401 }
 * @returns {Promise<object>} resolve 业务 data，reject Error(带 code/msg)
 */
function request(options) {
  const opts = Object.assign({ method: 'POST', needAuth: true, retryOn401: true }, options);

  return new Promise((resolve, reject) => {
    const header = Object.assign({ 'content-type': 'application/json' }, opts.header || {});
    const token = getToken();
    if (opts.needAuth && token) {
      header.Authorization = 'Bearer ' + token;
    }

    send(opts, header, {
      success(res) {
        const body = res.data || {};
        if (res.statusCode === 401 && opts.retryOn401) {
          // token 过期：重新登录后再试一次
          doLogin()
            .then(() => request(Object.assign({}, opts, { retryOn401: false })))
            .then(resolve)
            .catch(reject);
          return;
        }
        if (res.statusCode >= 200 && res.statusCode < 300 && body.code === 0) {
          resolve(body.data === undefined ? {} : body.data);
          return;
        }
        const error = new Error(body.msg || '服务开小差了，请稍后重试');
        error.code = body.code || res.statusCode;
        error.statusCode = res.statusCode;
        tracker.track('api_error', {
          url: opts.url,
          status: res.statusCode,
          code: error.code,
          msg: error.message,
        });
        reject(error);
      },
      fail(err) {
        const error = new Error('网络连接失败，请检查网络后重试');
        error.code = 'NETWORK';
        error.raw = err;
        tracker.track('api_error', {
          url: opts.url,
          status: 0,
          code: 'NETWORK',
          msg: (err && err.errMsg) || 'request fail',
        });
        reject(error);
      },
    });
  });
}

/** 静默登录：wx.login 拿 code -> 后端换 token */
function doLogin() {
  if (reloginPromise) return reloginPromise;
  reloginPromise = new Promise((resolve, reject) => {
    wx.login({
      success(res) {
        if (!res.code) {
          reject(new Error('微信登录失败'));
          return;
        }
        request({
          url: '/api/auth/login',
          data: { code: res.code },
          needAuth: false,
          retryOn401: false,
        })
          .then((data) => {
            setToken(data.token);
            if (data.openid) {
              tracker.setUserId(data.openid);
            }
            resolve(data);
          })
          .catch(reject);
      },
      fail() {
        reject(new Error('微信登录失败'));
      },
    });
  }).then(
    (data) => {
      reloginPromise = null;
      return data;
    },
    (err) => {
      reloginPromise = null;
      throw err;
    }
  );
  return reloginPromise;
}

function ensureLogin() {
  if (getToken()) return Promise.resolve({ token: getToken() });
  return doLogin();
}

const api = {
  request,
  login: doLogin,
  ensureLogin,

  /**
   * 客户端下发配置（广告位 ID / 业务规则）
   * 为什么走服务端：广告位要等「流量主」开通才有，而小程序改代码要重新提审几天；
   * 放服务端就是「云托管改环境变量 -> 重新发布」，所有用户立刻生效。
   */
  clientConfig: () => request({ url: '/api/client/config', method: 'GET', needAuth: false, retryOn401: false }),

  /** 解析链接 */
  parse: (url) => ensureLogin().then(() => request({ url: '/api/parse', data: { url } })),

  /** 看完广告领「保存次数」（服务端每次 +rewardPerAd 次，24 小时有效） */
  claimAdReward: (payload) => ensureLogin().then(() => request({ url: '/api/quota/reward', data: payload })),

  /** 查询钱包：剩余保存次数 / 有效期 / 今天看广告的进度（以服务端为准） */
  wallet: () => ensureLogin().then(() => request({ url: '/api/quota', method: 'GET' })),

  /**
   * 保存前扣 1 次
   * ★ 这是唯一扣次数的地方，账本在服务端：客户端只是「先问一下够不够」，
   *   改前端绕不过去，所以刷次数没意义。
   */
  consumeCredit: (payload) => ensureLogin().then(() => request({ url: '/api/credit/consume', data: payload || {} })),

};

module.exports = api;
