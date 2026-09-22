/**
 * MySQL 持久化自测（不需要真的有一个 MySQL）
 * ------------------------------------------------------------------
 * 用法：node tools/test-mysql.js
 *
 * 为什么要用「假驱动」测：本机没装 MySQL、云托管里的库外网也连不上，
 * 但「重新发布会不会丢数据」这件事必须在部署前验证。
 * 所以这里注入一个假的 mysql2 驱动：把 SQL 记下来、把数据存在内存 Map 里，
 * 完整跑一遍「连库 -> 建表 -> 写数据 -> 模拟重新发布 -> 数据恢复」。
 * 它验证的是我们自己的逻辑（SQL 拼得对不对、key 映射对不对、失败会不会丢数据），
 * 不验证 mysql2 本身和网络。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP_DIR = path.join(os.tmpdir(), 'qsy-mysql-test-' + Date.now());

/* ----------------------------- 假驱动 ----------------------------- */

function makeFakeDriver(options = {}) {
  const store = new Map([...(options.seed || [])]);
  const state = {
    // 记下所有执行过的 SQL，用来断言我们拼的语句是参数化的、key 没写错
    sql: [],
    createDatabase: 0,
    failNextWrite: false,
    // 模拟「云托管刚开出来的库，database 还不存在」
    badDatabase: options.badDatabase || '',
    databaseCreated: false,
  };

  function createPool(opts) {
    const database = opts.database || '';
    return {
      async getConnection() {
        if (state.badDatabase && database === state.badDatabase && !state.databaseCreated) {
          const err = new Error('Unknown database ' + database);
          err.code = 'ER_BAD_DB_ERROR';
          throw err;
        }
        return { release() {} };
      },
      async query(sql, params) {
        state.sql.push({ sql, params });
        const head = String(sql).trim().slice(0, 40).toUpperCase();
        if (head.startsWith('CREATE DATABASE')) {
          state.createDatabase += 1;
          state.databaseCreated = true;
          return [{ affectedRows: 0 }];
        }
        if (head.startsWith('CREATE TABLE')) return [{ affectedRows: 0 }];
        if (head.startsWith('SELECT')) {
          return [Array.from(store.entries()).map(([k, v]) => ({ k, v }))];
        }
        if (head.startsWith('INSERT INTO')) {
          if (state.failNextWrite) {
            state.failNextWrite = false;
            throw new Error('模拟写库失败');
          }
          const list = params || [];
          for (let i = 0; i < list.length; i += 2) store.set(list[i], list[i + 1]);
          return [{ affectedRows: list.length / 2 }];
        }
        return [[]];
      },
      async end() {},
    };
  }

  return { createPool, store, state };
}

/* ----------------------------- 断言工具 ----------------------------- */

let failures = 0;

function ok(name, extra) {
  console.log(`[OK] ${name}${extra ? '  ' + extra : ''}`);
}

function fail(name, detail) {
  failures += 1;
  console.error(`[FAIL] ${name}  ${detail || ''}`);
}

function assert(name, condition, detail) {
  if (condition) ok(name, detail);
  else fail(name, detail);
}

function freshStore() {
  // 模拟「容器重新发布」：清掉模块缓存重新加载，和重启进程一个效果
  // 注意只重载 store：mysql 模块要留着重用同一个假驱动实例
  delete require.cache[require.resolve('../src/store')];
  return require('../src/store');
}

/* ----------------------------- 主流程 ----------------------------- */

(async function main() {
  console.log('MySQL 持久化自测（用假驱动，不需要真的数据库）\n');

  process.env.MYSQL_ADDRESS = '10.0.0.9:3306';
  process.env.MYSQL_USERNAME = 'tester';
  process.env.MYSQL_PASSWORD = 'secret';
  process.env.MYSQL_DATABASE = 'qushuiyin_test';
  process.env.TOKEN_SECRET = 'test-secret';

  const config = require('../src/config');
  config.dataDir = TMP_DIR; // 必须在 require store 之前改：store 加载时就会建目录

  const mysql = require('../src/mysql');
  const fake = makeFakeDriver();
  mysql.setDriverForTest(fake);

  // ---------- 1. 连库 + 建表 ----------
  const store = require('../src/store');
  await store.initStorage();
  const status = store.storageStatus();
  assert('能连上数据库', status.connected === true, status.error || '');
  assert(
    '建了 kv 表（app_store）',
    fake.state.sql.some((item) => /CREATE TABLE IF NOT EXISTS .app_store./i.test(item.sql)),
    ''
  );

  // ---------- 2. 写埋点 -> 落盘 -> 同步进数据库 ----------
  const now = Date.now();
  // 用 store 自己的日期口径（本地时区），别用 UTC，否则晚上跑会跨天对不上
  const today = store.dateKey(now);
  store.writeEvents(
    [
      { e: 'app_launch', uid: 'u_test_1', sid: 's1', ts: now, p: 'pages/index/index', props: { scene: 1001 } },
      { e: 'parse_success', uid: 'u_test_1', sid: 's1', ts: now, p: 'pages/result/result', props: { platform: 'douyin', cost_ms: 1200 } },
      { e: 'ad_click', uid: 'u_test_1', sid: 's1', ts: now, p: 'pages/result/result', props: { ad_type: 'rewarded_video', method: 'intent' } },
    ],
    { user_id: 'openid_test_1' }
  );
  store.flush();
  await mysql.flushPending();

  const keys = Array.from(fake.store.keys());
  const rollupKey = 'rollup/' + today + '.json';
  assert('汇总写进了数据库', keys.indexOf(rollupKey) > -1, keys.join(', '));
  assert('key 用的是正斜杠（跨平台一致）', keys.every((k) => k.indexOf('\\') < 0), '');
  assert('UV 索引也写进了数据库', keys.indexOf('uv_index.json') > -1, '');

  const insertSql = fake.state.sql.filter((item) => /INSERT INTO/i.test(item.sql)).pop();
  assert('写库用的是参数化 SQL（防注入）', !!insertSql && /ON DUPLICATE KEY UPDATE/i.test(insertSql.sql), '');
  assert('SQL 里没有直接拼 JSON 内容', !!insertSql && insertSql.sql.indexOf('{') < 0, '');

  const rollup = JSON.parse(fake.store.get(rollupKey));
  assert('UV 统计正确（1 个用户）', Object.keys(rollup.uv).length === 1, '');
  assert('计算次数统计正确（parse_success=1）', rollup.parse.success === 1, '');
  assert('广告点击统计正确（ad_click=1）', rollup.ad.click === 1, '');

  // ---------- 3. 模拟「重新发布」：换掉磁盘和内存，数据应该从数据库回来 ----------
  const before = fake.store.get(rollupKey);
  fs.rmSync(TMP_DIR, { recursive: true, force: true });
  assert('模拟部署：本地 data 目录已清空', !fs.existsSync(TMP_DIR), '');

  const store2 = freshStore();
  mysql.setDriverForTest(fake); // 模拟重新发布 = 连接重建
  await store2.initStorage();
  const metrics = store2.dayMetrics(today);

  assert('重新发布后 UV 还在', metrics.uv === 1, 'uv=' + metrics.uv);
  assert('重新发布后计算次数还在', metrics.parse_success === 1, 'parse_success=' + metrics.parse_success);
  assert('重新发布后广告点击还在', metrics.ad_click === 1, 'ad_click=' + metrics.ad_click);
  assert('数据库里的汇总没被改写', fake.store.get(rollupKey) === before, '');

  // ---------- 4. 用户余额（看广告领的次数）也要能恢复 ----------
  store2.grantAdCredits('openid_test_1');
  store2.flush();
  await mysql.flushPending();
  assert('余额写进了数据库', fake.store.has('wallet.json'), '');
  const wallet = JSON.parse(fake.store.get('wallet.json') || '{}');
  assert(
    '余额数值对得上（看一次广告送 10 次）',
    wallet.openid_test_1 && wallet.openid_test_1.credits === config.business.rewardPerAd,
    JSON.stringify(wallet.openid_test_1 || {})
  );

  // ---------- 5. 写库失败时不能把数据弄丢 ----------
  fake.state.failNextWrite = true;
  store2.touchUser('openid_test_2');
  store2.flush();
  await mysql.flushPending();
  assert('写库失败后数据留在待写队列里等重试', mysql.status().pending > 0, 'pending=' + mysql.status().pending);
  await mysql.flushPending();
  assert('重试后写成功', mysql.status().pending === 0, '');

  // ---------- 6. 库不存在时自动建库 ----------
  const fake2 = makeFakeDriver({ badDatabase: 'auto_create_demo' });
  config.mysql.address = '10.0.0.9:3306';
  config.mysql.database = 'auto_create_demo';
  mysql.setDriverForTest(fake2);
  const created = await mysql.init(TMP_DIR);
  assert('库不存在时自动建库并连上', created === true && fake2.state.createDatabase === 1, mysql.status().error || '');

  // ---------- 7. 没配数据库时安静退回文件存储 ----------
  config.mysql.address = '';
  config.mysql.host = '';
  config.mysql.user = '';
  config.mysql.password = '';
  mysql.setDriverForTest(makeFakeDriver());
  const used = await mysql.init(TMP_DIR);
  const s = mysql.status();
  assert('没配 MySQL 时退回文件存储（服务照常跑）', used === false && s.enabled === false && s.connected === false, '');

  fs.rmSync(TMP_DIR, { recursive: true, force: true });

  if (failures) {
    console.error(`\n❌ 有 ${failures} 项没通过`);
    process.exit(1);
  }
  console.log('\n✅ 全部通过：数据库存储这块可以放心用');
})().catch((err) => {
  console.error('[FAIL] 测试本身崩了：', err);
  process.exit(1);
});
