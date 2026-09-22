/**
 * GET /api/proxy?url=xxx&s=签名
 * 资源中转：把第三方 CDN 的视频/图片流式转发给小程序。
 * 为什么需要它：微信要求小程序请求的域名必须在后台配置白名单，
 * 而各平台 CDN 域名千变万化（还经常换），不可能逐个配置，所以统一中转一层。
 * 注意：中转会消耗你服务器的带宽，量大的话建议换成对象存储 + CDN。
 */
const http = require('http');
const https = require('https');
const { URL } = require('url');
const config = require('../config');
const logger = require('../logger');
const { hmac, isPrivateHost } = require('../utils');

const REDIRECT_CODES = [301, 302, 303, 307, 308];

function signValid(rawUrl, sign) {
  if (!config.proxy.sign) return true;
  if (!sign) return false;
  try {
    return hmac(rawUrl, config.tokenSecret).slice(0, 16) === String(sign);
  } catch (err) {
    return false;
  }
}

function requestStream(target, headers, redirects = 0) {
  return new Promise((resolve, reject) => {
    const lib = target.protocol === 'https:' ? https : http;
    const req = lib.request(
      target,
      { method: 'GET', headers, timeout: config.proxy.timeout },
      (upstream) => {
        if (REDIRECT_CODES.includes(upstream.statusCode) && upstream.headers.location && redirects < 3) {
          upstream.resume();
          let next;
          try {
            next = new URL(upstream.headers.location, target);
          } catch (err) {
            reject(new Error('上游返回了非法跳转地址'));
            return;
          }
          resolve(requestStream(next, headers, redirects + 1));
          return;
        }
        resolve(upstream);
      }
    );
    req.on('timeout', () => req.destroy(new Error('上游响应超时')));
    req.on('error', reject);
    req.end();
  });
}

async function proxy(ctx) {
  const { req, res, query } = ctx;
  const rawUrl = query.url;

  if (!rawUrl) {
    res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('缺少 url 参数');
    return;
  }
  if (!signValid(rawUrl, query.s)) {
    res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('链接签名无效，请重新解析');
    return;
  }

  let target;
  try {
    target = new URL(rawUrl);
  } catch (err) {
    res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('url 参数不合法');
    return;
  }

  if (!['http:', 'https:'].includes(target.protocol)) {
    res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('只支持 http/https');
    return;
  }
  if (!config.proxy.allowPrivate && isPrivateHost(target.hostname)) {
    res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('不允许访问内网地址');
    return;
  }
  if (config.proxy.allowHosts.length && !config.proxy.allowHosts.includes(target.hostname)) {
    res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('该域名不在允许列表中');
    return;
  }

  const headers = {
    // 部分 CDN 会校验 UA / Referer，这里带一个常规浏览器的值
    'user-agent':
      'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
    accept: '*/*',
  };
  if (req.headers.range) headers.range = req.headers.range;
  if (target.origin) headers.referer = target.origin + '/';

  let upstream;
  try {
    upstream = await requestStream(target, headers);
  } catch (err) {
    logger.warn('中转失败:', target.hostname, err.message);
    res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('资源获取失败');
    return;
  }

  const passHeaders = {
    'content-type': upstream.headers['content-type'] || 'application/octet-stream',
    'cache-control': 'public, max-age=3600',
    'access-control-allow-origin': '*',
  };
  ['content-length', 'content-range', 'accept-ranges', 'last-modified', 'etag'].forEach((key) => {
    if (upstream.headers[key]) passHeaders[key] = upstream.headers[key];
  });

  res.writeHead(upstream.statusCode || 200, passHeaders);

  let received = 0;
  upstream.on('data', (chunk) => {
    received += chunk.length;
    if (received > config.proxy.maxBytes) {
      logger.warn('中转超出大小上限，已中断:', target.hostname);
      upstream.destroy();
      res.destroy();
    }
  });
  upstream.on('error', () => res.destroy());
  req.on('close', () => upstream.destroy());
  upstream.pipe(res);
}

module.exports = { proxy };
