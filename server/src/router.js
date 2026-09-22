/**
 * 路由表 + 上下文构建
 */
const config = require('./config');
const logger = require('./logger');
const ratelimit = require('./ratelimit');
const { currentUser } = require('./auth');
const { readJsonBody, sendError, clientIp } = require('./utils');
const store = require('./store');

const authHandler = require('./handlers/auth');
const parseHandler = require('./handlers/parse');
const trackHandler = require('./handlers/track');
const statsHandler = require('./handlers/stats');
const proxyHandler = require('./handlers/proxy');
const clientHandler = require('./handlers/client');

const routes = [
  { method: 'POST', path: '/api/auth/login', handler: authHandler.login, auth: false, limit: 'api' },
  // 客户端下发配置（广告位 ID / 业务规则）：不需要登录，启动时就要拿到
  { method: 'GET', path: '/api/client/config', handler: clientHandler.clientConfig, auth: false, limit: 'api' },
  { method: 'POST', path: '/api/parse', handler: parseHandler.parse, auth: true, limit: 'parse' },
  { method: 'GET', path: '/api/quota', handler: parseHandler.quota, auth: true, limit: 'api' },
  { method: 'POST', path: '/api/quota/reward', handler: parseHandler.reward, auth: true, limit: 'api' },
  // 保存到相册前扣 1 次（唯一扣次数的地方，服务端说了算）
  { method: 'POST', path: '/api/credit/consume', handler: parseHandler.consume, auth: true, limit: 'api' },
  { method: 'POST', path: '/api/track', handler: trackHandler.track, auth: false, limit: 'track' },
  { method: 'GET', path: '/api/user/summary', handler: statsHandler.userSummary, auth: true, limit: 'api' },
  {
    method: 'GET',
    path: '/api/stats/summary',
    handler: statsHandler.summary,
    auth: false,
    admin: true,
    limit: 'api',
  },
  { method: 'GET', path: '/api/proxy', handler: proxyHandler.proxy, auth: false, limit: 'api' },
  {
    method: 'GET',
    path: '/api/health',
    handler: (ctx) => {
      ctx.res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      ctx.res.end(
        JSON.stringify({
          code: 0,
          data: {
            ok: true,
            uptime: Math.round(process.uptime()),
            provider: config.parse.provider,
            wechat_configured: !!(config.wechat.appId && config.wechat.appSecret),
            // 存储方式：看到 file 就说明没用上数据库（云托管重新发布会丢数据）
            storage: store.storageStatus().connected ? 'mysql' : 'file',
            db_connected: store.storageStatus().connected,
            db_error: store.storageStatus().error || '',
            dates: store.listDates().slice(-3),
          },
        })
      );
    },
    auth: false,
    limit: 'api',
  },
];

function match(method, pathname) {
  return routes.find((route) => route.method === method && route.path === pathname) || null;
}

function baseUrlOf(req) {
  const proto = req.headers['x-forwarded-proto'] || (req.socket.encrypted ? 'https' : 'http');
  const host = req.headers['x-forwarded-host'] || req.headers.host || '127.0.0.1:' + config.port;
  return proto + '://' + host;
}

/**
 * 处理一个请求
 * @returns {Promise<boolean>} 是否已被路由处理
 */
async function handle(req, res, url) {
  const route = match(req.method.toUpperCase(), url.pathname);
  if (!route) return false;

  const ctx = {
    req,
    res,
    url,
    query: Object.fromEntries(url.searchParams.entries()),
    body: {},
    user: null,
    baseUrl: baseUrlOf(req),
    ip: clientIp(req),
  };

  // 限流
  const rules = config.rateLimit[route.limit] || config.rateLimit.api;
  if (rules) {
    const result = ratelimit.hit(route.limit + ':' + ctx.ip, rules.windowMs, rules.max);
    if (!result.ok) {
      res.writeHead(429, { 'content-type': 'application/json; charset=utf-8', 'retry-after': result.retryAfter });
      res.end(JSON.stringify({ code: 429, msg: '操作太频繁了，歇一会儿再试', data: null }));
      return true;
    }
  }

  // 登录态
  // 云托管内网调用带过来的 openid 是平台注入的，比自签 token 更可信，优先用
  const cloudOpenid = authHandler.cloudOpenidOf(req);
  ctx.user = cloudOpenid ? { openid: cloudOpenid, cloud: true } : currentUser(req);
  if (route.auth && !ctx.user) {
    sendError(res, 401, '登录已过期，请重新进入小程序', 401);
    return true;
  }

  // 管理端校验
  if (route.admin && ctx.query.token !== config.adminToken) {
    sendError(res, 403, '看板口令不对', 403);
    return true;
  }

  // 请求体
  if (['POST', 'PUT', 'PATCH'].includes(req.method.toUpperCase())) {
    try {
      ctx.body = await readJsonBody(req);
    } catch (err) {
      sendError(res, err.statusCode || 400, err.message || '请求体解析失败', err.statusCode || 400);
      return true;
    }
  }

  try {
    await route.handler(ctx);
  } catch (err) {
    logger.error('接口异常', url.pathname, err);
    if (!res.headersSent) {
      sendError(res, 500, '服务器开小差了，请稍后重试', 200);
    } else {
      res.end();
    }
  }
  return true;
}

module.exports = { handle, routes, match, baseUrlOf };
