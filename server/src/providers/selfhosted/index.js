/**
 * 自建解析（不花解析费，但要自己维护）
 * 目前支持：抖音。
 * 加新平台：在同目录写一个 xxx.js，导出 { parse({ url }) }，返回和 mock/http 一样的结构，
 *          然后注册到下面的 ADAPTERS 里即可（平台识别见 src/platform.js）。
 */

const douyin = require('./douyin');
const platform = require('../../platform');

const ADAPTERS = {
  douyin,
};

const SUPPORTED = Object.keys(ADAPTERS);

async function parse(ctx) {
  const key = platform.detect(ctx.url);
  const adapter = ADAPTERS[key];
  if (!adapter) {
    throw Object.assign(
      new Error('自建解析暂不支持' + platform.name(key) + '，可在 .env 里配置 PARSE_FALLBACK_PROVIDER 交给第三方接口兜底'),
      { code: 1002, unsupported: true }
    );
  }
  const result = await adapter.parse(ctx);
  return Object.assign({ provider: 'selfhosted:' + key }, result);
}

module.exports = { parse, ADAPTERS, SUPPORTED };
