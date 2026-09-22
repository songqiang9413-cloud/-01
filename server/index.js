/**
 * 清月去水印 · 小程序后端（零依赖，Node 18+）
 * 启动：node index.js  （或 npm start）
 *
 * 提供的接口：
 *   POST /api/auth/login     wx.login 换 token
 *   POST /api/parse          解析链接（服务端权威统计「计算次数」）
 *   GET  /api/quota          查询剩余次数
 *   POST /api/quota/reward   看广告后领次数
 *   POST /api/track          埋点批量上报（UV / 事件 / 广告）
 *   GET  /api/user/summary   单个用户的统计
 *   GET  /api/stats/summary  看板汇总数据
 *   GET  /api/proxy          资源中转（给小程序下载/预览用）
 *   GET  /api/health         健康检查
 *   GET  /admin              数据看板
 *   GET  /demo/*             内置演示素材
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const config = require('./src/config');
const logger = require('./src/logger');
const router = require('./src/router');
const store = require('./src/store');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.mp4': 'video/mp4',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
};

const STATIC_ROOTS = [
  { prefix: '/admin', dir: path.join(config.root, 'admin'), index: 'index.html' },
  { prefix: '/demo', dir: path.join(config.root, 'demo') },
];

/** 静态文件服务（只暴露 admin 和 demo 两个目录，且禁止 ../ 穿越） */
function serveStatic(req, res, pathname) {
  const root = STATIC_ROOTS.find((item) => pathname === item.prefix || pathname.startsWith(item.prefix + '/'));
  if (!root) return false;

  let relative = pathname.slice(root.prefix.length);
  if (relative === '' || relative === '/') relative = '/' + (root.index || 'index.html');
  const filePath = path.normalize(path.join(root.dir, decodeURIComponent(relative)));
  if (!filePath.startsWith(root.dir)) {
    res.writeHead(403).end('Forbidden');
    return true;
  }
  if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('404 Not Found');
    return true;
  }

  const stat = fs.statSync(filePath);
  const ext = path.extname(filePath).toLowerCase();
  const headers = {
    'content-type': MIME[ext] || 'application/octet-stream',
    'content-length': stat.size,
    'cache-control': ext === '.html' ? 'no-store' : 'public, max-age=600',
  };

  // 视频支持 Range，小程序拖动进度条要靠它
  const range = req.headers.range;
  if (range && /^bytes=\d*-\d*$/.test(range)) {
    const [startText, endText] = range.replace('bytes=', '').split('-');
    const start = startText ? parseInt(startText, 10) : 0;
    const end = endText ? parseInt(endText, 10) : stat.size - 1;
    if (start >= stat.size) {
      res.writeHead(416, { 'content-range': 'bytes */' + stat.size }).end();
      return true;
    }
    res.writeHead(206, Object.assign({}, headers, {
      'content-range': `bytes ${start}-${end}/${stat.size}`,
      'content-length': end - start + 1,
      'accept-ranges': 'bytes',
    }));
    fs.createReadStream(filePath, { start, end }).pipe(res);
    return true;
  }

  res.writeHead(200, Object.assign({ 'accept-ranges': 'bytes' }, headers));
  if (req.method === 'HEAD') {
    res.end();
    return true;
  }
  fs.createReadStream(filePath).pipe(res);
  return true;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const started = Date.now();

  res.on('finish', () => {
    // 中转和静态资源不记日志，太吵
    if (url.pathname.startsWith('/api/') && url.pathname !== '/api/proxy') {
      logger.info(req.method, url.pathname, res.statusCode, (Date.now() - started) + 'ms');
    }
  });

  try {
    if (await router.handle(req, res, url)) return;
    if (serveStatic(req, res, url.pathname)) return;

    if (url.pathname.startsWith('/api/')) {
      res.writeHead(404, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ code: 404, msg: '接口不存在', data: null }));
      return;
    }
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('404 Not Found');
  } catch (err) {
    logger.error('未捕获的异常', err);
    if (!res.headersSent) {
      res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ code: 500, msg: '服务器内部错误', data: null }));
    } else {
      res.end();
    }
  }
});

// 定期把内存里的统计数据落盘
const flushTimer = setInterval(() => store.flush(), 30000);
flushTimer.unref();

function shutdown(signal) {
  logger.info('收到', signal, '，正在保存数据…');
  try {
    store.flush();
  } catch (err) {
    logger.error('保存数据失败', err);
  }
  // 把还在排队等写库的数据推完（没配数据库时这个调用什么都不做）
  const mysql = require('./src/mysql');
  mysql.close().catch(() => {});
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3500).unref();
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('uncaughtException', (err) => logger.error('uncaughtException', err));
process.on('unhandledRejection', (err) => logger.error('unhandledRejection', err));

function listen() {
  server.listen(config.port, config.host, () => {
  const base = `http://127.0.0.1:${config.port}`;
  logger.info('服务已启动');
  logger.info('  本地地址    ', base);
  logger.info('  数据看板    ', `${base}/admin?token=${config.adminToken}`);
  logger.info('  健康检查    ', `${base}/api/health`);
  logger.info(
    '  解析服务商  ',
    config.parse.provider,
    config.parse.provider === 'mock' ? '（演示模式，不会真的解析）' : ''
  );
  const storage = store.storageStatus();
  logger.info('  数据存储    ', storage.connected ? 'MySQL（重新发布不丢数据）' : '本地文件（重新发布会清空）');
  if (config.parse.fallbackProvider) {
    logger.info('  兜底服务商  ', config.parse.fallbackProvider, '（主服务商失败时自动切换，看板会记「自建降级次数」）');
  }
  logger.info('  数据目录    ', config.dataDir);
  if (config.ad.units.rewardedVideo) {
    logger.info('  激励视频位  ', config.ad.units.rewardedVideo, '（由服务端下发，改环境变量即可换广告位）');
  } else {
    logger.warn('  没有配 AD_UNIT_REWARDED：小程序拿不到激励视频广告位，保存会直接放行');
  }

  if (!config.wechat.appId || !config.wechat.appSecret) {
    logger.warn('  未配置 WX_APPID / WX_SECRET：当前为开发模式，所有用户共用一个虚拟 openid');
  }
  if (config.tokenSecret === 'dev-token-secret' || config.tokenSecret.indexOf('change-me') === 0) {
    logger.warn('  TOKEN_SECRET 还是默认值，上线前务必改成随机长字符串');
  }
  if (config.adminToken === 'admin123') {
    logger.warn('  ADMIN_TOKEN 还是默认值，上线前务必改掉，否则任何人都能看你的数据看板');
  }
  if (config.parse.provider === 'mock') {
    logger.warn('  PARSE_PROVIDER=mock：解析接口会返回内置演示视频，接真实接口请改 .env');
  }
  if (storage.enabled && !storage.connected) {
    logger.warn('  配了 MySQL 但没连上：', storage.error || '未知错误', '（后台会继续重试）');
  }
  });
}

/**
 * 启动前先把数据库里的历史数据捞回本地文件，再开始接客。
 * 为什么要有这一步：容器每次重新发布都是全新的磁盘，UV / 计算次数 / 广告点击
 * 和用户余额都躺在数据库里，不先捞回来就统计就会从 0 开始。
 */
(async function main() {
  try {
    await store.initStorage();
  } catch (err) {
    logger.error('初始化存储失败，改用本地文件继续启动', err);
  }
  listen();
})();

module.exports = server;
