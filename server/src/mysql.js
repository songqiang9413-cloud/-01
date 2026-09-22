/**
 * MySQL 持久化（可选，但线上强烈建议打开）
 * ------------------------------------------------------------------
 * 为什么需要：
 *   微信云托管的容器**没有持久硬盘**，server/data 目录在每次「重新发布」后都会清空，
 *   结果就是 UV / 计算次数 / 广告点击 和用户手里攒的「保存次数」全部归零。
 *   绑定云托管自带的 MySQL 之后，这些数据写进数据库，重新发布也能接着用。
 *
 * 存什么：
 *   只存「小 JSON」—— 每天的汇总(rollup)、每天的防刷计数(quota)、用户档案(users)、
 *   首次出现日期(uv_index)、余额钱包(wallet)。
 *   原始事件流水(events/*.jsonl) 仍然只落本地磁盘：它只是排查问题用的日志，量最大、
 *   不需要长期保存，塞进数据库只会让库白白变大。
 *
 * 怎么存：
 *   一张 kv 表，k 就是「相对 data 目录的文件路径」（如 rollup/2026-09-23.json），
 *   v 是文件内容。这样数据库和本地文件是一一对应的，恢复时原样写回即可。
 *   这样存储层和业务层解耦，以后想换成正规表结构，只改这一个文件。
 *
 * 降级策略（很重要）：
 *   没装 mysql2、没配环境变量、数据库连不上 —— 任何一种情况都自动退回「只用本地文件」，
 *   服务照常跑，只是重新发布会丢数据。/api/health 和启动日志会显示当前用的是哪种存储，
 *   所以「以为存了其实没存」这种情况不会悄悄发生。
 *
 * 环境变量（云托管里绑定 MySQL 后，前三个平台会自动注入）：
 *   MYSQL_ADDRESS=10.0.0.5:3306    MYSQL_USERNAME=xxx    MYSQL_PASSWORD=xxx
 *   MYSQL_DATABASE（可选，默认 qushuiyin；库不存在会自动建）
 */
const fs = require('fs');
const path = require('path');
const config = require('./config');
const logger = require('./logger');

const TABLE = 'app_store';
// 一条 upsert 最多塞多少个占位符（一行 2 个），避免 SQL 太长被服务端拒绝
const MAX_PARAMS = 200;

let driver = null;
let pool = null;
let connected = false;
let lastError = '';
let hydrated = 0;
let saved = 0;
let retryTimer = null;
let retryCount = 0;

const pending = new Map(); // key -> JSON 文本，等着批量写库
let flushTimer = null;

/* ----------------------------- 基础工具 ----------------------------- */

/** mysql2 是可选依赖：装不上也要能跑（退回文件存储），所以用 try 包住 */
function loadDriver() {
  if (driver) return driver;
  try {
    // eslint-disable-next-line global-require
    driver = require('mysql2/promise');
  } catch (err) {
    driver = null;
  }
  return driver;
}

/** 测试用：注入一个假的 mysql2 驱动，本机没有 MySQL 也能验证这段逻辑 */
function setDriverForTest(fake) {
  driver = fake;
  pool = null;
  connected = false;
  lastError = '';
}

/** 库名要拼进 SQL（标识符没法用占位符），所以只留字母数字下划线，防注入 */
function safeName(name) {
  return String(name).replace(/[^0-9A-Za-z_$]/g, '') || 'qushuiyin';
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 把 MYSQL_ADDRESS（host:port）和 MYSQL_HOST/MYSQL_PORT 两种写法统一成一个对象 */
function settings() {
  const m = config.mysql;
  let host = m.host || '';
  let port = m.port || 3306;
  if (m.address) {
    const text = String(m.address).trim().replace(/^mysql:\/\//, '');
    const idx = text.lastIndexOf(':');
    if (idx > 0) {
      host = text.slice(0, idx);
      port = Number(text.slice(idx + 1)) || port;
    } else {
      host = text;
    }
  }
  return { host, port, user: m.user, password: m.password, database: safeName(m.database) };
}

function isEnabled() {
  const s = settings();
  return !!(s.host && s.user && s.password);
}

/* ----------------------------- 连接 ----------------------------- */

function baseOptions(s, withDatabase) {
  const opts = {
    host: s.host,
    port: s.port,
    user: s.user,
    password: s.password,
    charset: 'utf8mb4',
    // 连不上要快点失败：启动时最多等两轮，太久会拖慢容器启动（云托管的健康检查会超时）
    connectTimeout: 5000,
    waitForConnections: true,
    connectionLimit: 4,
    // 时间交给 Node 处理，容器时区通常是 UTC，不能让数据库自作主张转换
    timezone: 'Z',
  };
  if (withDatabase) opts.database = s.database;
  return opts;
}

function isBadDatabase(err) {
  const code = (err && err.code) || '';
  return code === 'ER_BAD_DB_ERROR' || code === 'ER_DBACCESS_DENIED_ERROR';
}

async function connect() {
  const s = settings();
  try {
    pool = driver.createPool(baseOptions(s, true));
    const conn = await pool.getConnection();
    conn.release();
  } catch (err) {
    // 云托管刚开的库可能还没有同名 database，这里自动建一个再连
    if (!isBadDatabase(err)) throw err;
    logger.warn('[mysql] 数据库不存在，自动创建：', s.database);
    if (pool) {
      try {
        await pool.end();
      } catch (e) {
        /* ignore */
      }
      pool = null;
    }
    const tmp = driver.createPool(baseOptions(s, false));
    await tmp.query(
      'CREATE DATABASE IF NOT EXISTS `' + s.database + '` DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci'
    );
    await tmp.end();
    pool = driver.createPool(baseOptions(s, true));
    const conn = await pool.getConnection();
    conn.release();
  }

  await pool.query(
    'CREATE TABLE IF NOT EXISTS `' +
      TABLE +
      '` (' +
      '`k` VARCHAR(191) NOT NULL,' +
      '`v` LONGTEXT NOT NULL,' +
      '`updated_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,' +
      'PRIMARY KEY (`k`)' +
      ') ENGINE=InnoDB DEFAULT CHARSET=utf8mb4'
  );
  connected = true;
  lastError = '';
  retryCount = 0;
}

/**
 * 把数据库里的数据写回本地 data 目录（启动时先做这一步，之后再让业务代码读文件）
 * 注意：数据库里的版本会覆盖本地文件 —— 因为容器里的本地文件本来就是一次性的。
 */
async function hydrate(dataDir) {
  const [rows] = await pool.query('SELECT `k`, `v` FROM `' + TABLE + '`');
  let count = 0;
  rows.forEach((row) => {
    const key = String(row.k || '');
    if (!key) return;
    const file = path.resolve(dataDir, key);
    // 防目录穿越：key 必须是 data 目录内的相对路径
    const rel = path.relative(dataDir, file);
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, String(row.v), 'utf8');
    count += 1;
  });
  hydrated = count;
  return count;
}

/* ----------------------------- 写入 ----------------------------- */

/** 排进待写队列（同一秒内的多次改动会合并成一条 upsert） */
function put(key, text) {
  if (!key || !isEnabled()) return;
  pending.set(key, text);
  scheduleFlush();
}

function scheduleFlush() {
  if (flushTimer) return;
  flushTimer = setTimeout(() => {
    flushPending().catch((err) => logger.error('[mysql] 定时写入异常：', err.message));
  }, 1500);
  if (flushTimer.unref) flushTimer.unref();
}

async function flushPending() {
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  if (!connected || !pool || !pending.size) return 0;

  const entries = Array.from(pending.entries());
  pending.clear();
  const perStatement = Math.max(1, Math.floor(MAX_PARAMS / 2));
  let ok = 0;

  for (let i = 0; i < entries.length; i += perStatement) {
    const chunk = entries.slice(i, i + perStatement);
    const params = [];
    chunk.forEach(([k, v]) => {
      params.push(k, v);
    });
    const sql =
      'INSERT INTO `' +
      TABLE +
      '` (`k`, `v`) VALUES ' +
      chunk.map(() => '(?, ?)').join(', ') +
      // VALUES(v) 在 MySQL 8.0.20 之后标记为过时但仍可用；这里要兼容 5.7，所以不用新语法
      ' ON DUPLICATE KEY UPDATE `v` = VALUES(`v`)';
    try {
      await pool.query(sql, params);
      ok += chunk.length;
    } catch (err) {
      lastError = err.message;
      logger.error('[mysql] 写入失败：', err.message);
      // 写失败的放回队列，下次 flush 再试；键的数量是「天数」级别，不会无限涨
      chunk.forEach(([k, v]) => {
        if (!pending.has(k)) pending.set(k, v);
      });
      break;
    }
  }
  saved += ok;
  return ok;
}

/* ----------------------------- 启动 / 停止 ----------------------------- */

/** 连不上时后台慢慢重试：云托管的数据库有可能比服务晚几秒才能用 */
function scheduleRetry() {
  if (retryTimer) return;
  retryTimer = setTimeout(async () => {
    retryTimer = null;
    retryCount += 1;
    try {
      await connect();
      logger.info('[mysql] 重连成功，之后的数据会写进数据库');
      flushPending().catch(() => {});
    } catch (err) {
      lastError = err.message;
      // 前 5 次每分钟试一次，之后 5 分钟一次，避免日志刷屏
      if (retryCount < 5) scheduleRetry();
      else {
        retryTimer = setTimeout(() => {
          retryTimer = null;
          scheduleRetry();
        }, 5 * 60 * 1000);
        if (retryTimer.unref) retryTimer.unref();
      }
    }
  }, 60000);
  if (retryTimer.unref) retryTimer.unref();
}

/**
 * 启动入口：连库 + 把数据捞回本地文件。返回是否用上了数据库。
 * @param {string} dataDir 本地数据目录
 */
async function init(dataDir) {
  if (!isEnabled()) {
    logger.info('[mysql] 没配 MYSQL_ADDRESS/USERNAME/PASSWORD，用本地文件存储（重新发布会丢数据）');
    return false;
  }
  if (!loadDriver()) {
    logger.warn('[mysql] 配了数据库但没装 mysql2（npm install），暂时用本地文件存储');
    return false;
  }

  for (let i = 1; i <= 2; i += 1) {
    try {
      await connect();
      break;
    } catch (err) {
      lastError = err.message;
      if (i < 2) await sleep(1000);
    }
  }

  if (!connected) {
    logger.error('[mysql] 连接失败，先用本地文件存储，后台会继续重试：', lastError);
    scheduleRetry();
    return false;
  }

  try {
    const count = await hydrate(dataDir);
    const s = settings();
    logger.info('[mysql] 已连接', s.host + ':' + s.port + '/' + s.database, '，从数据库恢复', count, '份数据');
  } catch (err) {
    lastError = err.message;
    logger.error('[mysql] 读取历史数据失败（不影响服务，只是没恢复旧数据）：', err.message);
  }
  return true;
}

/** 关服前把待写数据清空，别丢最后几秒的埋点 */
async function close() {
  try {
    await flushPending();
  } catch (err) {
    /* ignore */
  }
  if (pool) {
    try {
      await pool.end();
    } catch (err) {
      /* ignore */
    }
    pool = null;
  }
  connected = false;
}

function status() {
  const s = settings();
  return {
    enabled: isEnabled(),
    connected,
    driver: !!driver,
    database: s.database,
    host: s.host ? s.host + ':' + s.port : '',
    hydrated,
    saved,
    pending: pending.size,
    error: lastError,
  };
}

module.exports = {
  init,
  close,
  put,
  flushPending,
  hydrate,
  status,
  isEnabled,
  setDriverForTest,
};
