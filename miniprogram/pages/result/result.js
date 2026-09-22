const app = getApp();
const gConfig = require('../../config/index');
const tracker = require('../../utils/tracker');
const ad = require('../../utils/ad');
const util = require('../../utils/util');
const api = require('../../utils/request');

Page({
  data: {
    record: null,
    isVideo: true,
    mediaSrc: '',
    saving: false,
    progress: 0,
    showBanner: ad.unitReady(gConfig.adUnits.bannerResult),
    bannerUnit: gConfig.adUnits.bannerResult,
    notFound: false,
    platformName: '',
    timeText: '',
    // 保存次数（看广告领的，24 小时有效）
    credits: 0,
    remainHours: 0,
    rewardPerAd: gConfig.business.rewardPerAd,
    validHours: gConfig.business.validHours,
  },

  onLoad(options) {
    const id = decodeURIComponent(options.id || '');
    const record = app.getHistory().find((item) => item.id === id);
    if (!record) {
      this.setData({ notFound: true });
      return;
    }
    const isVideo = (record.type || 'video') !== 'image';
    // 优先用服务端给的直连地址（域名已进白名单时不占服务器带宽），没有再走中转
    const mediaSrc = record.directUrl || this.proxyUrl();
    this.setData({
      record,
      isVideo,
      mediaSrc,
      platformName: record.platformName || util.platformName(record.platform),
      timeText: util.formatTime(new Date(record.ts)),
    });
    tracker.track('result_view', {
      request_id: record.id,
      platform: record.platform,
      media_type: record.type || 'video',
      title_len: (record.title || '').length,
    });
  },

  onShow() {
    tracker.pageView('pages/result/result');
    // 回到结果页时刷新一下钱包（可能刚在别处看过广告）
    app.refreshWallet().then((wallet) => this.applyWallet(wallet));
  },

  onHide() {
    tracker.pageLeave('pages/result/result');
  },

  onUnload() {
    tracker.pageLeave('pages/result/result');
  },

  onVideoPlay() {
    if (!this.data.record) return;
    tracker.track('result_play', { request_id: this.data.record.id });
  },

  onVideoError(e) {
    const relay = this.proxyUrl();
    // 直连播不动（多半是域名不在小程序白名单里）→ 悄悄换成中转地址再试
    if (relay && this.data.mediaSrc !== relay) {
      tracker.track('play_fallback_relay', {
        request_id: this.data.record ? this.data.record.id : '',
        msg: (e && e.detail && e.detail.errMsg) || '',
      });
      this.setData({ mediaSrc: relay });
      return;
    }
    tracker.track('result_play_error', {
      request_id: this.data.record ? this.data.record.id : '',
      msg: (e && e.detail && e.detail.errMsg) || '',
    });
  },

  /** 中转地址（带签名，服务端下发的那串；没有就按配置兜底拼一个） */
  proxyUrl() {
    const record = this.data.record || {};
    return record.proxyUrl || gConfig.mediaProxy + encodeURIComponent(record.url || '');
  },

  /** 直连地址：服务端判定该域名在白名单里才会给，没有就返回空 */
  directUrl() {
    const record = this.data.record || {};
    return record.directUrl || '';
  },

  /* ----------------------------- 保存到相册 ----------------------------- */

  applyWallet(wallet) {
    if (!wallet) return;
    this.setData({
      credits: Math.max(0, Number(wallet.credits) || 0),
      remainHours: Number(wallet.remain_hours) || 0,
      rewardPerAd: Number(wallet.reward_per_ad) || gConfig.business.rewardPerAd,
      validHours: Number(wallet.valid_hours) || gConfig.business.validHours,
    });
  },

  /**
   * 保存前的「次数关卡」
   * @returns Promise<boolean> true = 可以继续保存
   *
   * 流程：先让服务端扣 1 次 → 扣成功就放行；
   *       次数不够（1003）就弹激励视频 → 看完领 10 次 → 再扣一次。
   */
  ensureCredit(retried) {
    const record = this.data.record;
    return api
      .consumeCredit({ scene: 'save', media_type: record.type || 'video' })
      .then((data) => {
        app.setWallet(data.wallet);
        this.applyWallet(data.wallet);
        tracker.track('credit_consume_success', {
          request_id: record.id,
          left: data.wallet.credits,
        });
        return true;
      })
      .catch((err) => {
        if (err.code === 1003 && !retried) {
          // 次数用完了 → 引导看广告
          return this.watchAdForCredit().then((ok) => (ok ? this.ensureCredit(true) : false));
        }
        if (err.code === 1003) {
          wx.showToast({ title: '保存次数还是不够，稍后再试', icon: 'none' });
          return false;
        }
        // 网络抖动之类的异常：不拦用户，放行并记一笔。
        // 宁可少赚这一次，也别让用户点了保存却什么都没发生。
        tracker.track('credit_consume_fail', { code: err.code, msg: err.message });
        return true;
      });
  },

  /** 弹激励视频，看完领次数 */
  watchAdForCredit() {
    tracker.track('save_need_ad', { position: 'result_save' });
    return new Promise((resolve) => {
      if (!ad.isRewardedAvailable()) {
        this.adFailPass('广告位没配置');
        resolve(true);
        return;
      }
      wx.showModal({
        title: '保存前看一小段广告',
        content:
          '看一次广告可以保存 ' +
          this.data.rewardPerAd +
          ' 次，' +
          this.data.validHours +
          ' 小时内都有效',
        confirmText: '看广告',
        cancelText: '再等等',
        confirmColor: '#337aff',
        success: (res) => {
          if (!res.confirm) {
            tracker.track('reward_modal_cancel', { scene: 'save' });
            resolve(false);
            return;
          }
          this.runRewardedVideo().then(resolve);
        },
      });
    });
  },

  runRewardedVideo() {
    return ad.showRewardedVideo({ position: 'result_save', scene: 'save_credit' }).then((result) => {
      if (!result.isEnded) {
        const reason = result.unavailable ? 'unavailable' : result.failed ? 'failed' : 'skip';
        tracker.track('reward_not_completed', { reason, scene: 'save' });
        if (result.unavailable || result.failed) {
          // 广告没放出来不赖用户
          this.adFailPass('广告没加载出来');
          return true;
        }
        wx.showToast({ title: '看完广告才能获得保存次数哦', icon: 'none' });
        return false;
      }
      return api
        .claimAdReward({ scene: 'save_credit', ad_type: 'rewarded_video' })
        .then((data) => {
          app.setWallet(data.wallet);
          this.applyWallet(data.wallet);
          tracker.track('reward_claim_success', {
            added: data.added,
            left: data.wallet.credits,
            scene: 'save',
          });
          wx.showToast({ title: '已获得 ' + data.added + ' 次', icon: 'none' });
          return true;
        })
        .catch((err) => {
          tracker.track('reward_claim_fail', { code: err.code, msg: err.message, scene: 'save' });
          wx.showToast({ title: err.message || '领取失败，请稍后重试', icon: 'none' });
          return false;
        });
    });
  },

  /** 广告放不出来时的兜底：放行保存，别让用户卡死 */
  adFailPass(reason) {
    tracker.track('ad_fail_open', { position: 'result_save', reason });
    wx.showToast({ title: '广告没加载出来，这次先给你保存', icon: 'none' });
  },

  onSave() {
    if (this.data.saving || !this.data.record) return;
    this.setData({ saving: true, progress: 0 });
    this.ensureCredit().then((ok) => {
      if (!ok) {
        this.setData({ saving: false });
        return;
      }
      this.doDownload();
    });
  },

  doDownload(useRelay) {
    const record = this.data.record;
    const relayUrl = this.proxyUrl();
    const url = useRelay ? relayUrl : this.data.mediaSrc;
    tracker.track('download_start', {
      request_id: record.id,
      media_type: record.type || 'video',
      direct: !useRelay && url !== relayUrl ? 1 : 0,
    });

    const task = wx.downloadFile({
      url,
      timeout: 60000,
      success: (res) => {
        if (res.statusCode !== 200) {
          this.onSaveFail('下载失败(' + res.statusCode + ')');
          return;
        }
        this.saveToAlbum(res.tempFilePath);
      },
      fail: (err) => {
        const msg = (err && err.errMsg) || '下载失败';
        // 直连下载失败（多半是这个域名还没加进小程序后台的白名单）→ 自动改用中转再试一次
        if (!useRelay && relayUrl && relayUrl !== url) {
          tracker.track('download_fallback_relay', {
            request_id: record.id,
            reason: String(msg).slice(0, 120),
          });
          this.doDownload(true);
          return;
        }
        this.onSaveFail(msg);
      },
    });

    if (task && task.onProgressUpdate) {
      task.onProgressUpdate((res) => {
        this.setData({ progress: res.progress });
      });
    }
  },

  saveToAlbum(filePath) {
    const isVideo = this.data.isVideo;
    const record = this.data.record;
    const success = () => {
      this.setData({ saving: false, progress: 100 });
      tracker.track('download_success', {
        request_id: record.id,
        media_type: record.type || 'video',
      });
      wx.showToast({ title: '已保存到相册', icon: 'success' });
    };
    const fail = (err) => {
      const msg = (err && err.errMsg) || '';
      this.setData({ saving: false });
      if (msg.indexOf('auth deny') > -1 || msg.indexOf('authorize') > -1) {
        tracker.track('download_fail', { request_id: record.id, reason: 'auth_deny' });
        wx.showModal({
          title: '需要相册权限',
          content: '保存视频需要你授权「保存到相册」，去设置里打开吧',
          confirmText: '去设置',
          success: (res) => {
            if (res.confirm) wx.openSetting({});
          },
        });
        return;
      }
      this.onSaveFail(msg || '保存失败');
    };

    if (isVideo) {
      wx.saveVideoToPhotosAlbum({ filePath, success, fail });
    } else {
      wx.saveImageToPhotosAlbum({ filePath, success, fail });
    }
  },

  onSaveFail(reason) {
    this.setData({ saving: false, progress: 0 });
    tracker.track('download_fail', {
      request_id: this.data.record ? this.data.record.id : '',
      reason: String(reason).slice(0, 200),
    });
    wx.showToast({ title: '保存失败，请重试', icon: 'none' });
  },

  /* ----------------------------- 其他操作 ----------------------------- */

  onCopy() {
    const record = this.data.record;
    if (!record) return;
    wx.setClipboardData({
      data: record.url,
      success: () => {
        tracker.track('copy_link', { request_id: record.id, platform: record.platform });
        wx.showToast({ title: '直链已复制', icon: 'none' });
      },
    });
  },

  onCopyText() {
    const record = this.data.record;
    if (!record) return;
    const text = '【' + util.platformName(record.platform) + '】去水印成功\n' + (record.title || '') + '\n' + record.url;
    wx.setClipboardData({
      data: text,
      success: () => {
        tracker.track('copy_text', { request_id: record.id });
        wx.showToast({ title: '已复制', icon: 'none' });
      },
    });
  },

  goHome() {
    // 返回首页时展示插屏广告（有频次限制，ad.js 里做了兜底）
    ad.showInterstitial('result_go_home');
    tracker.track('entry_click', { target: 'home', from: 'result' });
    wx.switchTab({ url: '/pages/index/index' });
  },

  goParseMore() {
    wx.switchTab({ url: '/pages/index/index' });
  },

  /* ----------------------------- 广告事件 ----------------------------- */

  onAdLoad(e) {
    ad.handleBannerLoad((e.currentTarget.dataset && e.currentTarget.dataset.slot) || 'result_bottom');
  },

  onAdError(e) {
    ad.handleBannerError((e.currentTarget.dataset && e.currentTarget.dataset.slot) || 'result_bottom', e);
  },

  onAdTap(e) {
    ad.handleBannerTap((e.currentTarget.dataset && e.currentTarget.dataset.slot) || 'result_bottom');
  },

  onShareAppMessage() {
    tracker.track('share_click', { channel: 'button', page: 'result' });
    const share = app.buildShare();
    share.title = '我用这个工具去掉了视频水印，你也试试';
    return share;
  },
});
