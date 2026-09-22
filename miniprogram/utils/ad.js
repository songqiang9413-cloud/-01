/**
 * 广告封装（激励视频 / 插屏 / Banner）+ 广告埋点
 * ------------------------------------------------------------------
 * 重要前提：微信广告组件**不提供点击回调**。
 *   - banner(<ad>)    只有 load / error 事件，没有 click 事件
 *   - 插屏广告        只有 show / close 事件
 *   - 激励视频        只有 load / error / close(isEnded) 事件
 * 所以「广告点击」在自建埋点里有两种口径，服务端会分开统计：
 *   1) method = 'intent'   ：用户主动点击「看广告得次数」这类入口 —— 口径最准，推荐作为主指标
 *   2) method = 'area_tap' ：用户在 banner 广告区域内的点击 —— 估算值（原生组件可能不冒泡）
 * 真实曝光/点击以后台「流量主-数据」为准，自建埋点用于和业务漏斗对齐。
 */

const gConfig = require('../config/index');
const storage = require('./storage');
const tracker = require('./tracker');

const PLACEHOLDER = /^adunit-0+[0-9]$/;

function unitReady(unitId) {
  return !!(gConfig.adEnabled && unitId && !PLACEHOLDER.test(unitId));
}

/* ------------------------------ 激励视频 ------------------------------ */

let rewardedAd = null;
let rewardedFailed = false;

function getRewardedAd() {
  if (rewardedAd) return rewardedAd;
  if (!unitReady(gConfig.adUnits.rewardedVideo) || typeof wx.createRewardedVideoAd !== 'function') {
    return null;
  }
  rewardedAd = wx.createRewardedVideoAd({ adUnitId: gConfig.adUnits.rewardedVideo });
  rewardedAd.onLoad(() => {
    rewardedFailed = false;
    tracker.track('ad_load', { ad_type: 'rewarded_video', ad_unit_id: gConfig.adUnits.rewardedVideo });
  });
  rewardedAd.onError((err) => {
    rewardedFailed = true;
    tracker.track('ad_load_fail', {
      ad_type: 'rewarded_video',
      ad_unit_id: gConfig.adUnits.rewardedVideo,
      code: (err && err.errCode) || '',
      msg: (err && err.errMsg) || '',
    });
  });
  return rewardedAd;
}

/** 提前加载，进首页时调用，能明显提高点开广告的成功率 */
function preloadRewardedVideo() {
  const ad = getRewardedAd();
  if (!ad) return;
  ad.load().catch(() => {
    /* 失败会在 onError 里打点，这里不重复处理 */
  });
}

/**
 * 播放激励视频
 * @param {object} options { position: 广告位位置，scene: 业务场景 }
 * @returns {Promise<{isEnded:boolean, watched:boolean}>}
 */
function showRewardedVideo(options = {}) {
  const ad = getRewardedAd();
  const position = options.position || 'unknown';
  if (!ad) {
    tracker.track('ad_unavailable', { ad_type: 'rewarded_video', position });
    return Promise.resolve({ isEnded: false, watched: false, unavailable: true });
  }

  // ★ 广告点击埋点（主口径）：用户主动点击了「看广告」入口
  tracker.track('ad_click', {
    ad_type: 'rewarded_video',
    ad_unit_id: gConfig.adUnits.rewardedVideo,
    position,
    scene: options.scene || '',
    method: 'intent',
  });

  return new Promise((resolve) => {
    let settled = false;

    function onClose(res) {
      ad.offClose(onClose);
      const isEnded = !res || res.isEnded === undefined ? true : !!res.isEnded;
      tracker.track('ad_close', {
        ad_type: 'rewarded_video',
        ad_unit_id: gConfig.adUnits.rewardedVideo,
        position,
        is_ended: isEnded,
      });
      if (isEnded) {
        tracker.track('ad_reward_success', {
          ad_type: 'rewarded_video',
          ad_unit_id: gConfig.adUnits.rewardedVideo,
          position,
          scene: options.scene || '',
        });
      }
      settled = true;
      resolve({ isEnded, watched: isEnded });
    }

    ad.onClose(onClose);

    ad.show()
      .then(() => {
        tracker.track('ad_show', {
          ad_type: 'rewarded_video',
          ad_unit_id: gConfig.adUnits.rewardedVideo,
          position,
        });
      })
      .catch(() => {
        // show 失败通常是没预加载成功：load 之后重试一次
        tracker.track('ad_show_fail', {
          ad_type: 'rewarded_video',
          ad_unit_id: gConfig.adUnits.rewardedVideo,
          position,
        });
        return ad
          .load()
          .then(() => ad.show())
          .then(() => {
            tracker.track('ad_show', {
              ad_type: 'rewarded_video',
              ad_unit_id: gConfig.adUnits.rewardedVideo,
              position,
              retry: true,
            });
          })
          .catch((err) => {
            ad.offClose(onClose);
            if (!settled) {
              settled = true;
              tracker.track('ad_show_fail', {
                ad_type: 'rewarded_video',
                ad_unit_id: gConfig.adUnits.rewardedVideo,
                position,
                retry: true,
                msg: (err && err.errMsg) || '',
              });
              wx.showToast({ title: '广告还没准备好，请稍后再试', icon: 'none' });
              resolve({ isEnded: false, watched: false, failed: true });
            }
          });
      });
  });
}

function isRewardedAvailable() {
  return unitReady(gConfig.adUnits.rewardedVideo) && typeof wx.createRewardedVideoAd === 'function';
}

/* ------------------------------ 插屏广告 ------------------------------ */

let interstitialAd = null;
let lastInterstitialAt = 0;

/**
 * 展示插屏广告（结果页返回首页时比较合适）
 * @param {string} position
 */
function showInterstitial(position = 'unknown') {
  if (!unitReady(gConfig.adUnits.interstitial) || typeof wx.createInterstitialAd !== 'function') {
    return;
  }
  const now = Date.now();
  if (now - lastInterstitialAt < (gConfig.interstitialMinInterval || 60000)) {
    return;
  }
  if (!interstitialAd) {
    interstitialAd = wx.createInterstitialAd({ adUnitId: gConfig.adUnits.interstitial });
    interstitialAd.onError((err) => {
      tracker.track('ad_load_fail', {
        ad_type: 'interstitial',
        ad_unit_id: gConfig.adUnits.interstitial,
        code: (err && err.errCode) || '',
        msg: (err && err.errMsg) || '',
      });
    });
    interstitialAd.onClose(() => {
      tracker.track('ad_close', {
        ad_type: 'interstitial',
        ad_unit_id: gConfig.adUnits.interstitial,
        position,
      });
    });
  }
  interstitialAd
    .show()
    .then(() => {
      lastInterstitialAt = Date.now();
      storage.set('last_interstitial', lastInterstitialAt);
      tracker.track('ad_show', {
        ad_type: 'interstitial',
        ad_unit_id: gConfig.adUnits.interstitial,
        position,
      });
    })
    .catch(() => {
      /* 未加载出来是常态，不打扰用户 */
    });
}

/* ------------------------------ Banner 广告 ------------------------------ */

/** <ad bindload="onAdLoad" data-slot="xxx"> */
function handleBannerLoad(slot) {
  // banner 没有独立的「展示」事件，加载成功就意味着它已经渲染在页面上了，
  // 所以 load 和 show 一起记，看板统计口径才是完整的。
  tracker.track('ad_load', { ad_type: 'banner', position: slot, ad_unit_id: bannerUnitBySlot(slot) });
  tracker.track('ad_show', { ad_type: 'banner', position: slot, ad_unit_id: bannerUnitBySlot(slot) });
}

/** <ad binderror="onAdError" data-slot="xxx"> */
function handleBannerError(slot, err) {
  tracker.track('ad_load_fail', {
    ad_type: 'banner',
    position: slot,
    ad_unit_id: bannerUnitBySlot(slot),
    code: (err && err.detail && err.detail.errCode) || '',
    msg: (err && err.detail && err.detail.errMsg) || '',
  });
}

/**
 * banner 区域点击（估算口径）
 * 说明：<ad> 是原生组件，点击事件不一定能冒泡到外层，所以这个数只会小于等于真实点击。
 */
function handleBannerTap(slot) {
  tracker.track('ad_click', {
    ad_type: 'banner',
    ad_unit_id: bannerUnitBySlot(slot),
    position: slot,
    method: 'area_tap',
  });
}

function bannerUnitBySlot(slot) {
  const map = {
    home_bottom: gConfig.adUnits.bannerHome,
    result_bottom: gConfig.adUnits.bannerResult,
  };
  return map[slot] || '';
}

module.exports = {
  unitReady,
  isRewardedAvailable,
  preloadRewardedVideo,
  showRewardedVideo,
  showInterstitial,
  handleBannerLoad,
  handleBannerError,
  handleBannerTap,
  bannerUnitBySlot,
};
