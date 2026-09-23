const app = getApp();
const gConfig = require('../../config/index');
const tracker = require('../../utils/tracker');
const api = require('../../utils/request');
const ad = require('../../utils/ad');
const util = require('../../utils/util');

Page({
  data: {
    inputUrl: '',
    parsing: false,
    // 保存次数（看广告领的，24 小时有效）
    credits: 0,
    remainHours: 0,
    rewardPerAd: gConfig.business.rewardPerAd,
    validHours: gConfig.business.validHours,
    // 广告位是否已开通：没开通时保存免费，文案也跟着变
    adReady: ad.isRewardedAvailable(),
    detectPlatform: 'unknown',
    detectPlatformName: '',
    // 广告：广告位 ID 还是占位值时不渲染 <ad>，避免开发者工具里一直报错
    showBanner: ad.unitReady(gConfig.adUnits.bannerHome),
    bannerUnit: gConfig.adUnits.bannerHome,
    // 常见问题展开态
    faqOpen: false,
    loadingTip: '',
    platforms: ['抖音', '快手', '小红书', '哔哩哔哩', '西瓜视频', '微视', '微博', '皮皮虾'],
    steps: [
      { n: '1', t: '复制链接', d: '在短视频 App 里点分享 → 复制链接' },
      { n: '2', t: '粘贴解析', d: '回到这里点「粘贴链接」→「一键去水印」' },
      { n: '3', t: '保存相册', d: '在结果页点「保存到相册」就行' },
    ],
  },

  onLoad() {
    tracker.pageView('pages/index/index', { from: 'load' });
    // 登录成功后同步一次真实次数（服务端口径）
    app.onReady(() => {
      this.syncWallet();
    });
    this.unwatch = app.watchWallet((wallet) => this.applyWallet(wallet));
  },

  onShow() {
    tracker.pageView('pages/index/index');
    app.refreshWallet().then((wallet) => this.applyWallet(wallet));
    // 服务端可能刚下发广告位配置，这里顺手同步一次
    this.setData({ adReady: ad.isRewardedAvailable() });
    ad.preloadRewardedVideo();
  },

  onHide() {
    tracker.pageLeave('pages/index/index');
  },

  onUnload() {
    if (this.unwatch) this.unwatch();
    tracker.pageLeave('pages/index/index');
  },

  applyWallet(wallet) {
    if (!wallet) return;
    this.setData({
      credits: Math.max(0, Number(wallet.credits) || 0),
      remainHours: Number(wallet.remain_hours) || 0,
      rewardPerAd: Number(wallet.reward_per_ad) || gConfig.business.rewardPerAd,
      validHours: Number(wallet.valid_hours) || gConfig.business.validHours,
    });
  },

  syncWallet() {
    return app.refreshWallet().then((wallet) => this.applyWallet(wallet));
  },

  /* ----------------------------- 输入交互 ----------------------------- */

  onInput(e) {
    const value = e.detail.value;
    const platform = util.detectPlatform(value);
    this.setData({
      inputUrl: value,
      detectPlatform: platform,
      detectPlatformName: platform !== 'unknown' ? util.platformName(platform) : '',
    });
  },

  onClear() {
    tracker.track('input_clear', {});
    this.setData({ inputUrl: '', detectPlatform: 'unknown', detectPlatformName: '' });
  },

  /**
   * 从剪贴板粘贴
   * 注意：wx.getClipboardData 必须在用户点击事件里调用，否则新版微信会拦截，
   * 所以这里不做「进入首页自动读剪贴板」（参考项目那种写法现在已经不可靠了）。
   */
  onPaste() {
    wx.getClipboardData({
      success: (res) => {
        const text = (res.data || '').trim();
        const url = util.extractUrl(text);
        if (!url) {
          tracker.track('paste_fail', { has_content: !!text });
          wx.showToast({ title: '剪贴板里没有链接', icon: 'none' });
          return;
        }
        const platform = util.detectPlatform(url);
        this.setData({
          inputUrl: url,
          detectPlatform: platform,
          detectPlatformName: util.platformName(platform),
        });
        tracker.track('paste_success', { platform, source: 'clipboard' });
        wx.showToast({ title: '已粘贴', icon: 'none' });
      },
      fail: () => {
        wx.showToast({ title: '读取剪贴板失败', icon: 'none' });
      },
    });
  },

  toggleFaq() {
    this.setData({ faqOpen: !this.data.faqOpen });
    tracker.track('faq_toggle', { open: !this.data.faqOpen });
  },

  /* ----------------------------- 解析主流程 ----------------------------- */

  onSubmit() {
    const raw = (this.data.inputUrl || '').trim();
    const url = util.extractUrl(raw);

    tracker.track('parse_submit', {
      has_input: !!raw,
      has_url: !!url,
      platform: this.data.detectPlatform,
      input_len: raw.length,
      credits: this.data.credits,
    });

    if (!raw) {
      wx.showToast({ title: '请先粘贴视频链接', icon: 'none' });
      return;
    }
    if (!url) {
      wx.showToast({ title: '没识别到链接，请复制完整的分享文案', icon: 'none' });
      return;
    }
    if (this.data.parsing) return;

    this.doParse(url);
  },

  doParse(url) {
    const done = tracker.timer('parse_success', {
      platform: this.data.detectPlatform,
    });
    const parsingStart = Date.now();
    tracker.track('parse_start', { platform: this.data.detectPlatform });

    this.setData({ parsing: true, loadingTip: '正在解析，请稍候…' });

    api
      .parse(url)
      .then((data) => {
        // ★ 计算次数（成功口径）埋点
        done({
          request_id: data.request_id || '',
          media_type: data.type || 'video',
          title_len: (data.title || '').length,
        });

        if (data.wallet) {
          app.setWallet(data.wallet);
          this.applyWallet(data.wallet);
        }

        const record = {
          id: data.request_id || util.randomId('r_'),
          url: data.url,
          // 素材地址：directUrl = CDN 直连（省服务器带宽，需在微信后台配好 downloadFile 白名单）
          //          proxyUrl  = 服务端中转兜底（带签名，直连失败时自动用它）
          directUrl: data.direct_url || '',
          proxyUrl: data.proxy_url || '',
          cover: data.cover || '',
          title: data.title || '',
          author: data.author || '',
          platform: data.platform || this.data.detectPlatform,
          platformName: data.platform_name || util.platformName(data.platform || this.data.detectPlatform),
          type: data.type || 'video',
          ts: Date.now(),
          timeText: util.formatTime(new Date()),
        };
        app.addHistory(record);

        this.setData({ parsing: false, loadingTip: '' });
        wx.navigateTo({
          url: '/pages/result/result?id=' + encodeURIComponent(record.id),
        });
      })
      .catch((err) => {
        // ★ 解析失败埋点
        tracker.track('parse_fail', {
          platform: this.data.detectPlatform,
          code: err.code || '',
          msg: err.message || '',
          cost_ms: Date.now() - parsingStart,
        });
        this.setData({ parsing: false, loadingTip: '' });

        wx.showModal({
          title: '解析失败',
          content: err.message || '链接可能已失效，换个链接试试',
          showCancel: false,
          confirmText: '我知道了',
        });
      });
  },

  /*
   * 注意：首页这里原本有个「看广告加次数」的入口，现在**广告只在结果页点保存时弹**，
   * 所以首页不再有激励视频入口，只展示剩余次数。
   * 想看广告主动加次数的入口留在「我的」页（pages/mine）。
   */

  /* ----------------------------- 广告事件 ----------------------------- */

  onAdLoad(e) {
    ad.handleBannerLoad((e.currentTarget.dataset && e.currentTarget.dataset.slot) || 'home_bottom');
  },

  onAdError(e) {
    ad.handleBannerError((e.currentTarget.dataset && e.currentTarget.dataset.slot) || 'home_bottom', e);
  },

  onAdTap(e) {
    ad.handleBannerTap((e.currentTarget.dataset && e.currentTarget.dataset.slot) || 'home_bottom');
  },

  /* ----------------------------- 其他 ----------------------------- */

  goHistory() {
    tracker.track('entry_click', { target: 'history' });
    wx.navigateTo({ url: '/pages/history/history' });
  },

  onShareAppMessage() {
    tracker.track('share_click', { channel: 'button', page: 'index' });
    const share = app.buildShare();
    share.title = '清月水印处理工具｜粘贴链接就能存无水印原片';
    return share;
  },

  onShareTimeline() {
    tracker.track('share_click', { channel: 'timeline', page: 'index' });
    return { title: gConfig.share.title, query: 'from=timeline&from_uid=' + tracker.getMeta().uid };
  },
});
