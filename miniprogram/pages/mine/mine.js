const app = getApp();
const gConfig = require('../../config/index');
const tracker = require('../../utils/tracker');
const api = require('../../utils/request');
const storage = require('../../utils/storage');
const ad = require('../../utils/ad');

const DEFAULT_AVATAR = '/images/avatar-default.png';

Page({
  data: {
    avatarUrl: DEFAULT_AVATAR,
    nickName: '',
    // 保存次数钱包（看广告领的，24 小时有效）
    wallet: {
      credits: 0,
      remain_hours: 0,
      reward_per_ad: gConfig.business.rewardPerAd,
      valid_hours: gConfig.business.validHours,
    },
    totalParse: 0,
    todayParse: 0,
    todayAd: 0,
    historyCount: 0,
    version: '1.0.0',
    // 激励视频广告位可用时才显示「看广告领次数」按钮
    showRewardBtn: ad.isRewardedAvailable(),
  },

  onLoad() {
    tracker.pageView('pages/mine/mine', { from: 'load' });
    this.setData({
      avatarUrl: storage.get('avatar_url', '') || DEFAULT_AVATAR,
      nickName: storage.get('nick_name', ''),
      historyCount: app.getHistory().length,
    });
  },

  onShow() {
    tracker.pageView('pages/mine/mine');
    app.refreshWallet().then((wallet) => {
      this.setData({ wallet: wallet || this.data.wallet });
    });
    this.loadSummary();
  },

  onHide() {
    tracker.pageLeave('pages/mine/mine');
  },

  onUnload() {
    tracker.pageLeave('pages/mine/mine');
  },

  loadSummary() {
    api
      .request({ url: '/api/user/summary', method: 'GET' })
      .then((data) => {
        this.setData({
          totalParse: data.total_parse || 0,
          todayParse: data.today_parse || 0,
          todayAd: data.today_ad || 0,
        });
      })
      .catch(() => {
        /* 统计接口失败不影响页面 */
      });
  },

  /** 新版头像获取方式（wx.getUserInfo 从 2022-10-25 起已被回收，这里用「头像昵称填写能力」） */
  onChooseAvatar(e) {
    const url = e.detail.avatarUrl;
    if (!url) return;
    storage.set('avatar_url', url);
    this.setData({ avatarUrl: url });
    tracker.track('profile_set', { field: 'avatar' });
  },

  onNickInput(e) {
    this.setData({ nickName: e.detail.value });
  },

  onNickBlur(e) {
    const value = (e.detail.value || '').trim();
    storage.set('nick_name', value);
    tracker.track('profile_set', { field: 'nickname', len: value.length });
  },

  /** 主动看广告加次数（主要入口在结果页点保存时，这里是给「想提前多攒几次」的用户留的） */
  onWatchAd() {
    // 广告位没开通时点按钮什么都不会发生，给一句人话
    if (!ad.isRewardedAvailable()) {
      tracker.track('reward_btn_no_ad', { scene: 'mine_credit' });
      wx.showToast({ title: '广告还没开放，直接保存就行', icon: 'none' });
      return;
    }
    ad.showRewardedVideo({ position: 'mine_reward', scene: 'mine_credit' }).then((result) => {
      if (!result.isEnded) {
        if (!result.unavailable && !result.failed) {
          wx.showToast({ title: '看完广告才能获得次数哦', icon: 'none' });
        }
        return;
      }
      api
        .claimAdReward({ scene: 'mine_credit', ad_type: 'rewarded_video' })
        .then((data) => {
          if (data.wallet) {
            app.setWallet(data.wallet);
            this.setData({ wallet: data.wallet });
          }
          tracker.track('reward_claim_success', {
            added: data.added || 0,
            left: data.wallet ? data.wallet.credits : '',
            scene: 'mine',
          });
          wx.showToast({ title: '已获得 ' + (data.added || 0) + ' 次', icon: 'none' });
        })
        .catch((err) => {
          tracker.track('reward_claim_fail', { code: err.code || '', msg: err.message || '', scene: 'mine' });
          wx.showToast({ title: err.message || '领取失败', icon: 'none' });
        });
    });
  },

  goHistory() {
    tracker.track('entry_click', { target: 'history', from: 'mine' });
    wx.navigateTo({ url: '/pages/history/history' });
  },

  onClearCache() {
    wx.showModal({
      title: '清除本地缓存',
      content: '会清掉本地解析记录和头像昵称设置，不影响剩余保存次数。',
      success: (res) => {
        if (!res.confirm) return;
        const summary = app.globalData.wallet;
        storage.clearAll();
        app.globalData.wallet = summary;
        this.setData({ avatarUrl: DEFAULT_AVATAR, nickName: '', historyCount: 0 });
        tracker.track('cache_clear', {});
        wx.showToast({ title: '已清除', icon: 'success' });
      },
    });
  },

  onShareAppMessage() {
    tracker.track('share_click', { channel: 'button', page: 'mine' });
    return app.buildShare();
  },
});
