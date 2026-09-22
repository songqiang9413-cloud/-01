/**
 * 通用工具函数
 */
const crypto = require('crypto');
const net = require('net');

/** 2026-09-22 */
function dateKey(ts = Date.now(), offsetDays = 0) {
  const d = new Date(ts + offsetDays * 86400000);
  // 统一按东八区（线上服务器一般是 UTC，必须显式偏移，否则凌晨的数据会串天）
  const utc8 = new Date(d.getTime() + (8 * 60 + d.getTimezoneOffset()) * 60000);
  const y = utc8.getFullYear();
  const m = String(utc8.getMonth() + 1).padStart(2, '0');
  const day = String(utc8.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function hourOf(ts) {
  const d = new Date(ts);
  const utc8 = new Date(d.getTime() + (8 * 60 + d.getTimezoneOffset()) * 60000);
  return utc8.getHours();
}

function hmac(data, secret) {
  return crypto.createHmac('sha256', secret).update(String(data)).digest('hex');
}

function sha1(data) {
  return crypto.createHash('sha1').update(String(data)).digest('hex');
}

function base64url(buf) {
  return Buffer.from(buf)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function fromBase64url(str) {
  return Buffer.from(String(str).replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
}

/** 按 a.b.c 取值，取不到返回 '' */
function getPath(obj, pathStr) {
  if (!pathStr) return '';
  return String(pathStr)
    .split('.')
    .reduce((acc, key) => (acc === undefined || acc === null ? '' : acc[key]), obj);
}

function clientIp(req) {
  const forwarded = req.headers['x-forwarded-for'];
  if (forwarded) return String(forwarded).split(',')[0].trim();
  return (req.socket && req.socket.remoteAddress) || '';
}

/** 内网地址判断：中转接口不能变成打内网的跳板 */
function isPrivateHost(hostname) {
  if (!hostname) return true;
  const lower = hostname.toLowerCase();
  if (lower === 'localhost' || lower.endsWith('.local') || lower.endsWith('.internal')) return true;
  if (net.isIP(lower)) {
    if (lower === '0.0.0.0' || lower === '127.0.0.1' || lower === '::1') return true;
    if (/^10\./.test(lower)) return true;
    if (/^192\.168\./.test(lower)) return true;
    if (/^172\.(1[6-9]|2\d|3[01])\./.test(lower)) return true;
    if (/^169\.254\./.test(lower)) return true;
    if (/^f[cd]/i.test(lower)) return true;
    if (/^fe80:/i.test(lower)) return true;
  }
  return false;
}

function truncate(value, max = 200) {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  if (!text) return '';
  return text.length > max ? text.slice(0, max) + '…' : text;
}

/** 读取并解析 JSON 请求体，带大小限制 */
function readJsonBody(req, limit = 512 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(Object.assign(new Error('请求体过大'), { statusCode: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!chunks.length) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch (err) {
        reject(Object.assign(new Error('请求体不是合法 JSON'), { statusCode: 400 }));
      }
    });
    req.on('error', reject);
  });
}

/** 统一的响应格式：{ code, msg, data } */
function sendJson(res, data, statusCode = 200) {
  const body = JSON.stringify(data);
  res.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  });
  res.end(body);
}

function sendOk(res, data = {}, msg = 'ok') {
  sendJson(res, { code: 0, msg, data });
}

function sendError(res, code, msg, statusCode = 200) {
  sendJson(res, { code, msg, data: null }, statusCode);
}

module.exports = {
  dateKey,
  hourOf,
  hmac,
  sha1,
  base64url,
  fromBase64url,
  getPath,
  clientIp,
  isPrivateHost,
  truncate,
  readJsonBody,
  sendJson,
  sendOk,
  sendError,
};
