/**
 * 解析服务商：演示模式
 * 不接任何第三方接口，直接返回项目内置的演示素材，
 * 目的是让你在没有真实解析接口之前，也能把「解析 -> 预览 -> 保存 -> 埋点」整条链路跑通。
 */
const platform = require('../platform');

module.exports = {
  name: 'mock',

  async parse({ url, baseUrl }) {
    const key = platform.detect(url);
    return {
      type: 'video',
      url: baseUrl + '/demo/demo.mp4',
      cover: baseUrl + '/demo/demo-cover.jpg',
      title: '演示视频：演示模式不会真的解析你的链接',
      author: 'demo',
      platform: key,
      platform_name: platform.name(key),
      // local=true 表示素材就在本站，不需要再走资源中转
      local: true,
    };
  },
};
