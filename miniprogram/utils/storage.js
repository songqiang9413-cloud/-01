/**
 * 本地存储的薄封装：全部 try/catch，避免个别机型 storage 异常把页面搞崩
 */
const PREFIX = 'qsy_';

function set(key, value) {
  try {
    wx.setStorageSync(PREFIX + key, value);
    return true;
  } catch (err) {
    console.warn('[storage] set fail', key, err);
    return false;
  }
}

function get(key, defaultValue = '') {
  try {
    const value = wx.getStorageSync(PREFIX + key);
    return value === '' || value === null || value === undefined ? defaultValue : value;
  } catch (err) {
    console.warn('[storage] get fail', key, err);
    return defaultValue;
  }
}

function remove(key) {
  try {
    wx.removeStorageSync(PREFIX + key);
  } catch (err) {
    console.warn('[storage] remove fail', key, err);
  }
}

function clearAll() {
  try {
    const info = wx.getStorageInfoSync();
    (info.keys || []).forEach((key) => {
      if (key.indexOf(PREFIX) === 0) {
        wx.removeStorageSync(key);
      }
    });
  } catch (err) {
    console.warn('[storage] clear fail', err);
  }
}

module.exports = { set, get, remove, clearAll, PREFIX };
