/**
 * 解析服务商：第三方 HTTP 接口
 * ------------------------------------------------------------------
 * 国内做去水印基本都是买第三方解析接口（按次计费，几块钱一万次），
 * 因为各平台接口天天变，自己维护成本极高。
 *
 * 只要服务商给的是「传一个 url，返回一段 JSON」，就能用这个适配器接上，
 * 全部通过 .env 配置，不用改代码：
 *   PARSE_API_URL / PARSE_API_METHOD / PARSE_API_HEADERS / PARSE_API_BODY
 *   PARSE_FIELD_VIDEO / PARSE_FIELD_COVER / ...
 * ------------------------------------------------------------------
 */
const config = require('../config');
const platform = require('../platform');
const { getPath, truncate } = require('../utils');

function escapeForJson(text) {
  const quoted = JSON.stringify(String(text));
  return quoted.slice(1, -1);
}

/**
 * 服务商自己的余额/套餐问题（「剩余点数不足，请购买套餐」这类）。
 * 这种错误不能原样丢给用户看：要充值的是我们，跟用户没关系，
 * 所以统一换成「解析服务正在维护」，同时在服务端记一笔提醒自己去充值。
 */
const PROVIDER_QUOTA_RE = /点数不足|余额不足|套餐|欠费|已到期|已过期|次数不足|已用完/;

function buildBody(url) {
  const template = config.parse.apiBody || '{"url":"{url}"}';
  return template.replace(/\{url\}/g, escapeForJson(url));
}

/**
 * 有的服务商把参数全放在 query 上（GET ?uid=xx&key=xx&url=xxx），
 * 这时 PARSE_API_URL 里写 {url}，会被替换成编码后的链接；
 * 没写 {url} 就按原样请求（那种把链接放 body 的 POST 服务商）。
 */
function buildUrl(url) {
  const template = config.parse.apiUrl || '';
  if (template.indexOf('{url}') < 0) return template;
  return template.replace(/\{url\}/g, encodeURIComponent(url));
}

/**
 * 国内第三方接口的习惯是「HTTP 一律 200，用 body 里的 code 表示成败」。
 * 这里把业务错误码翻译成人话，避免把 code=404 当成解析成功。
 */
function businessError(data) {
  if (!data || typeof data !== 'object') return '';
  const raw = data.code !== undefined ? data.code : data.status !== undefined ? data.status : data.errno;
  if (raw === undefined || raw === null || raw === '') return '';
  const code = String(raw).toLowerCase();
  if (code === '0' || code === '1' || code === '200' || code === 'true' || code === 'success') return '';
  return (
    getPath(data, 'msg') ||
    getPath(data, 'message') ||
    getPath(data, 'data.msg') ||
    '解析服务返回错误码 ' + code
  );
}

/**
 * 买完接口往里填的时候最容易出两种错：地址还是示例、密钥里还留着中文占位符。
 * 提前拦下来，给一句人话提示，比让 fetch 抛 ByteString 报错好得多。
 */
function assertConfigured() {
  const { apiUrl, apiHeaders, apiBody } = config.parse;
  if (!apiUrl) {
    throw Object.assign(new Error('还没有配置第三方解析接口：请在 server/.env 里填 PARSE_API_URL'), { code: 1001 });
  }
  if (/api\.example\.com|服务商给你的地址/.test(apiUrl)) {
    throw Object.assign(new Error('PARSE_API_URL 还是示例地址，请换成服务商给你的真实接口地址'), { code: 1001 });
  }
  if (!/^https?:\/\//i.test(apiUrl)) {
    throw Object.assign(new Error('PARSE_API_URL 必须是 http(s):// 开头的完整地址'), { code: 1001 });
  }
  const badHeader = Object.keys(apiHeaders || {}).find((key) => /[\u4e00-\u9fa5]/.test(String(apiHeaders[key])));
  if (badHeader) {
    throw Object.assign(
      new Error('PARSE_API_HEADERS 里的「' + badHeader + '」还是中文占位符，请换成服务商给你的真实密钥'),
      { code: 1001 }
    );
  }
  if (/你的密钥|服务商给你的地址/.test(String(apiBody))) {
    throw Object.assign(new Error('PARSE_API_BODY 里还有中文占位符，请对照服务商文档改一下'), { code: 1001 });
  }
}

/** 把第三方返回的内容尽力转成 JSON；有些服务商会返回带前后缀的文本 */
function parseResponseText(text) {
  const trimmed = String(text || '').trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed);
  } catch (err) {
    // 常见情况：JSON 里混了 HTML，或者外层包了一层，尝试截取第一个 { 到最后一个 }
    const start = trimmed.indexOf('{');
    const end = trimmed.lastIndexOf('}');
    if (start > -1 && end > start) {
      try {
        return JSON.parse(trimmed.slice(start, end + 1));
      } catch (err2) {
        return null;
      }
    }
    return null;
  }
}

module.exports = {
  name: 'http',

  async parse({ url }) {
    assertConfigured();

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), config.parse.timeout);
    let res;
    let text;
    try {
      res = await fetch(buildUrl(url), {
        method: config.parse.apiMethod,
        headers: Object.assign(
          { 'content-type': 'application/json' },
          config.parse.apiHeaders || {}
        ),
        body: ['GET', 'HEAD'].includes(config.parse.apiMethod) ? undefined : buildBody(url),
        signal: controller.signal,
      });
      text = await res.text();
    } catch (err) {
      const message = err.name === 'AbortError' ? '解析服务超时' : '解析服务连接失败';
      throw Object.assign(new Error(message), { code: 1002, raw: String((err && err.message) || err) });
    } finally {
      clearTimeout(timer);
    }

    if (!res.ok) {
      throw Object.assign(new Error('解析服务返回 ' + res.status), {
        code: 1002,
        raw: truncate(text, 300),
      });
    }

    const data = parseResponseText(text);
    if (!data) {
      throw Object.assign(new Error('解析服务返回格式无法识别'), { code: 1002, raw: truncate(text, 300) });
    }

    const fields = config.parse.fields;
    const key = platform.detect(url);
    const typeRaw = String(getPath(data, fields.type) || '').toLowerCase();

    let type = typeRaw.indexOf('image') > -1 || typeRaw.indexOf('photo') > -1 ? 'image' : 'video';
    let mediaUrl = String(getPath(data, fields.video) || getPath(data, 'data.video_url') || '');
    let title = String(getPath(data, fields.title) || '');

    // 图集作品没有视频直链，但一般会带一组图：取第 1 张，并在标题里写清楚，
    // 口径和自建解析保持一致（小程序结果页本来就支持 type=image）
    if (!mediaUrl) {
      const images = getPath(data, fields.images);
      if (Array.isArray(images) && images.length) {
        const first = images[0];
        const firstUrl =
          typeof first === 'string'
            ? first
            : getPath(first, 'url') || getPath(first, 'url_list.0') || getPath(first, 'url_list');
        if (firstUrl && typeof firstUrl === 'string') {
          mediaUrl = firstUrl;
          type = 'image';
          title = (title || '图集') + '（共 ' + images.length + ' 张，当前为第 1 张）';
        }
      }
    }

    if (!mediaUrl) {
      const business = businessError(data);
      if (business && PROVIDER_QUOTA_RE.test(business)) {
        throw Object.assign(new Error('解析服务正在维护，请稍后再试'), {
          code: 1002,
          providerQuota: true,
          raw: business,
        });
      }
      throw Object.assign(
        new Error(business || '解析失败，可能是链接失效或该作品不支持解析'),
        { code: 1002, raw: truncate(data, 300) }
      );
    }

    return {
      type,
      url: mediaUrl,
      cover: String(getPath(data, fields.cover) || ''),
      title,
      author: String(getPath(data, fields.author) || ''),
      platform: key,
      platform_name: platform.name(key),
      local: false,
    };
  },
};
