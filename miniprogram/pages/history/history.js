const app = getApp();
const tracker = require('../../utils/tracker');
const storage = require('../../utils/storage');
const util = require('../../utils/util');

Page({
  data: {
    list: [],
    isEmpty: true,
  },

  onLoad() {
    tracker.pageView('pages/history/history', { from: 'load' });
  },

  onShow() {
    tracker.pageView('pages/history/history');
    this.loadList();
  },

  onHide() {
    tracker.pageLeave('pages/history/history');
  },

  onUnload() {
    tracker.pageLeave('pages/history/history');
  },

  loadList() {
    const list = app.getHistory().map((item) => ({
      id: item.id,
      title: item.title || '未获取到标题',
      cover: item.cover || '',
      type: item.type || 'video',
      isVideo: (item.type || 'video') !== 'image',
      platformName: item.platformName || util.platformName(item.platform),
      timeText: util.formatTime(new Date(item.ts)),
    }));
    this.setData({ list, isEmpty: list.length === 0 });
  },

  onOpen(e) {
    const id = e.currentTarget.dataset.id;
    tracker.track('history_open', { id });
    wx.navigateTo({ url: '/pages/result/result?id=' + encodeURIComponent(id) });
  },

  onDelete(e) {
    const id = e.currentTarget.dataset.id;
    wx.showModal({
      title: '删除这条记录？',
      content: '只删除本机的记录，不影响已保存到相册的文件',
      success: (res) => {
        if (!res.confirm) return;
        const list = app.getHistory().filter((item) => item.id !== id);
        storage.set('history', list);
        this.loadList();
        tracker.track('history_delete', { id });
      },
    });
  },

  onClearAll() {
    wx.showModal({
      title: '清空全部记录？',
      content: '清空后无法恢复',
      success: (res) => {
        if (!res.confirm) return;
        app.clearHistory();
        this.loadList();
        tracker.track('history_clear_all', {});
      },
    });
  },

  goParse() {
    wx.switchTab({ url: '/pages/index/index' });
  },
});
