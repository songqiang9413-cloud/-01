/**
 * 小程序入口
 * 职责：1) 初始化埋点  2) 静默登录  3) 维护全局「保存次数」钱包  4) 全局异常上报
 */
const gConfig = require('./config/index');
const tracker = require('./utils/tracker');
const api = require('./utils/request');
const ad = require('./utils/ad');
const storage = require('./utils/storage');

App({
  globalData: {
    config: gConfig,
    userInfo: null,
    openid: '',
    // 保存次数钱包（看广告领的），以服务端返回为准；未登录时先用本地默认值占位
    wallet: {
      credits: 0,
      remaining: 0,
      remain_hours: 0,
      expires_at: 0,
      reward_per_ad: gConfig.business.rewardPerAd,
      valid_hours: gConfig.business.validHours,
      ad_times_today: 0,
      ad_limit_per_day: gConfig.business.maxRewardPerDay,
      parse_today: 0,
      parse_limit_per_day: gConfig.business.parseDailyLimit,
    },
    // 从分享进来时带上的分享者 uid，用于统计分享拉新
    fromUid: '',
    systemInfo: null,
    ready: false,
    readyCallbacks: [],
  },

  onLaunch(options) {
    tracker.init({ launchOptions: options });

    // 云托管：初始化云能力，之后 utils/request.js 会用 callContainer 走内网调用后端
    const cloud = gConfig.cloud || {};
    if (cloud.envId && wx.cloud) {
      try {
        wx.cloud.init({ env: cloud.envId, traceUser: true });
      } catch (err) {
        // 基础库太低之类的情况：忽略，让请求层自己报错
      }
    }

    const query = (options && options.query) || {};
    this.globalData.fromUid = query.from_uid || query.fu || '';
    if (this.globalData.fromUid) {
      // 记录分享来源，落地在本地，用户后续登录时再关联
      storage.set('from_uid', this.globalData.fromUid);
    }

    this.silentLogin();
    ad.preloadRewardedVideo();
  },

  onShow(options) {
    // 热启动（从后台切回来）也要记一次，用来算使用频次
    if (this.globalData.ready) {
      const scene = options && options.scene;
      tracker.track('app_show', {
        scene,
        path: (options && options.path) || '',
      });
    }
  },

  onHide() {
    tracker.track('app_hide', {});
    tracker.flush();
  },

  onError(err) {
    tracker.captureError(err, { from: 'app.onError' });
  },

  onUnhandledRejection(res) {
    tracker.track('unhandled_rejection', {
      msg: (res && res.reason && (res.reason.message || res.reason.errMsg)) || String((res && res.reason) || ''),
    });
  },

  /** 静默登录：不需要用户授权，拿到 openid 用于服务端统计与限流 */
  silentLogin() {
    api
      .login()
      .then((data) => {
        this.globalData.openid = data.openid || '';
        this.globalData.userInfo = data.user ? data.user : null;
        if (data.wallet) {
          this.globalData.wallet = data.wallet;
        }
        this.globalData.ready = true;
        this.fireReady();
        // 埋点里补上用户标识，之后的 UV / 计算次数都能按用户维度对上
        tracker.track('login_success', {
          is_new_user: !!data.is_new_user,
          openid_tail: (data.openid || '').slice(-6),
          from_uid: storage.get('from_uid', ''),
        });
      })
      .catch((err) => {
        this.globalData.ready = true;
        this.fireReady();
        console.warn('[app] 静默登录失败', err);
        tracker.track('login_fail', { msg: (err && err.message) || 'unknown' });
      });
  },

  onReady(callback) {
    if (this.globalData.ready) {
      callback();
      return;
    }
    this.globalData.readyCallbacks.push(callback);
  },

  fireReady() {
    const list = this.globalData.readyCallbacks || [];
    this.globalData.readyCallbacks = [];
    list.forEach((fn) => {
      try {
        fn();
      } catch (err) {
        console.warn('[app] ready callback error', err);
      }
    });
  },

  /** 更新并广播「保存次数」钱包 */
  setWallet(wallet) {
    if (!wallet) return;
    this.globalData.wallet = Object.assign({}, this.globalData.wallet, wallet);
    // 兼容老字段名：页面统一读 remaining
    this.globalData.wallet.remaining = this.globalData.wallet.credits || 0;
    if (this.walletListeners) {
      this.walletListeners.forEach((fn) => fn(this.globalData.wallet));
    }
  },

  refreshWallet() {
    return api
      .wallet()
      .then((wallet) => {
        this.setWallet(wallet);
        return wallet;
      })
      .catch(() => this.globalData.wallet);
  },

  watchWallet(fn) {
    if (!this.walletListeners) this.walletListeners = [];
    this.walletListeners.push(fn);
    fn(this.globalData.wallet);
    return () => {
      this.walletListeners = (this.walletListeners || []).filter((item) => item !== fn);
    };
  },

  /** 统一的分享配置：带上分享者 uid，用于统计拉新 */
  buildShare() {
    const uid = tracker.getMeta().uid;
    return {
      title: gConfig.share.title,
      path: gConfig.share.path + '?from=share&from_uid=' + uid,
    };
  },

  /** 结果页需要的历史记录（本地保存，不依赖后端） */
  addHistory(record) {
    const list = storage.get('history', []);
    const next = [record].concat(list.filter((item) => item.id !== record.id)).slice(0, 50);
    storage.set('history', next);
    return next;
  },

  getHistory() {
    return storage.get('history', []);
  },

  clearHistory() {
    storage.set('history', []);
  },

});
