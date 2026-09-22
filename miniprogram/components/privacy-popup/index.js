/**
 * 隐私授权弹窗
 * 微信要求：涉及隐私接口（如保存到相册）时，必须先让用户同意《用户隐私保护指引》。
 * 用户未同意时调用隐私接口，会触发 wx.onNeedPrivacyAuthorization，
 * 此时把 resolve 存下来，等用户点了「同意」按钮（open-type="agreePrivacyAuthorization"）再回调。
 */
Component({
  data: {
    show: false,
  },

  lifetimes: {
    attached() {
      if (!wx.onNeedPrivacyAuthorization) return;
      wx.onNeedPrivacyAuthorization((resolve) => {
        this.pendingResolve = resolve;
        this.setData({ show: true });
      });
    },
  },

  methods: {
    onAgree() {
      this.setData({ show: false });
      if (this.pendingResolve) {
        this.pendingResolve({ event: 'agree', buttonId: 'agree-btn' });
        this.pendingResolve = null;
      }
    },

    onDisagree() {
      this.setData({ show: false });
      if (this.pendingResolve) {
        this.pendingResolve({ event: 'disagree' });
        this.pendingResolve = null;
      }
      wx.showToast({ title: '已拒绝，无法保存到相册', icon: 'none' });
    },

    openContract() {
      if (wx.openPrivacyContract) {
        wx.openPrivacyContract({
          fail: () => wx.showToast({ title: '隐私协议打开失败', icon: 'none' }),
        });
      }
    },
  },
});
