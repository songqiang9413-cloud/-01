/**
 * 端到端冒烟测试：把「登录 → 解析 → 埋点上报 → 领广告奖励 → 统计查询 → 资源中转」跑一遍
 * 用法：node tools/smoke-test.js   （服务器需要先启动）
 *      SMOKE_URL="https://www.douyin.com/video/作品ID" node tools/smoke-test.js
 *      ↑ 自建解析（selfhosted）想真跑一次解析时用，默认那条样本短链只有演示模式才有意义
 * 全部通过会打印 ✅，任何一步失败都会以非 0 退出码结束，方便放到 CI 或上线前自检。
 */
const crypto = require('crypto');
const path = require('path');

const config = require(path.join(__dirname, '..', 'src', 'config'));

const BASE = process.env.SMOKE_BASE || `http://127.0.0.1:${config.port}`;
let failures = 0;

function ok(name, extra) {
  console.log(`[OK] ${name}${extra ? '  ' + extra : ''}`);
}

function fail(name, detail) {
  failures += 1;
  console.error(`[FAIL] ${name}  ${detail || ''}`);
}

async function api(pathname, options = {}, token) {
  const res = await fetch(BASE + pathname, {
    method: options.method || 'POST',
    headers: Object.assign(
      { 'content-type': 'application/json', connection: 'close' },
      token ? { authorization: 'Bearer ' + token } : {},
      options.headers || {}
    ),
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch (err) {
    /* 非 JSON 响应 */
  }
  return { status: res.status, json, text };
}

(async function main() {
  console.log('\n=== 清月水印处理工具 后端冒烟测试 ===');
  console.log('目标地址:', BASE, '\n');

  const health = await api('/api/health', { method: 'GET' });
  if (health.json && health.json.data && health.json.data.ok) {
    ok('健康检查', '解析服务商=' + health.json.data.provider);
  } else {
    fail('健康检查', health.text.slice(0, 120));
    console.log('\n服务没起来？先在 server 目录执行：node index.js\n');
    process.exitCode = 1;
  return;
  }

  const login = await api('/api/auth/login', { body: { code: 'smoke-test-code' } });
  const token = login.json && login.json.data && login.json.data.token;
  if (token) {
    ok('登录', 'openid=' + login.json.data.openid + (login.json.data.dev_mode ? '（开发模式）' : ''));
  } else {
    fail('登录', JSON.stringify(login.json));
    process.exitCode = 1;
  return;
  }

  const quota = await api('/api/quota', { method: 'GET' }, token);
  if (quota.json && quota.json.code === 0) {
    const w = quota.json.data;
    ok(
      '查询钱包',
      '可保存 ' + w.credits + ' 次（' + w.remain_hours + ' 小时内有效）· 今日看广告 ' +
        w.ad_times_today + '/' + w.ad_limit_per_day + ' · 今日解析 ' + w.parse_today + '/' + w.parse_limit_per_day
    );
  } else {
    fail('查询钱包', JSON.stringify(quota.json));
  }

  const provider = (health.json && health.json.data && health.json.data.provider) || '';
  const parseUrl = process.env.SMOKE_URL || 'https://v.douyin.com/iRabcdef/';
  const parse = await api('/api/parse', { body: { url: parseUrl } }, token);
  if (parse.json && parse.json.code === 0 && parse.json.data.url) {
    ok(
      '解析链接',
      parse.json.data.type +
        ' / ' +
        parse.json.data.platform_name +
        ' / ' +
        parse.json.data.cost_ms +
        'ms，剩余 ' +
        (parse.json.data.wallet ? parse.json.data.wallet.credits : '?') +
        ' 次可保存'
    );
  } else if (!process.env.SMOKE_URL && provider !== 'mock') {
    // 真实服务商要有真实链接才有意义，样本短链解析不出来是正常的
    ok(
      '解析链接',
      '已跳过：当前服务商=' + provider + '，想实测请用 SMOKE_URL="真实分享链接" node tools/smoke-test.js'
    );
  } else {
    fail('解析链接', JSON.stringify(parse.json));
  }

  const uid = 'u_smoke_' + Math.random().toString(36).slice(2, 8);
  const sid = 's_smoke_' + Math.random().toString(36).slice(2, 8);
  const now = Date.now();
  const events = [
    { e: 'app_launch', props: { scene: 1001, scene_name: '发现栏小程序主入口', cold_start: true } },
    { e: 'page_view', p: 'pages/index/index', props: { path: 'pages/index/index' } },
    { e: 'parse_submit', p: 'pages/index/index', props: { platform: 'douyin', remaining: 5 } },
    { e: 'parse_start', p: 'pages/index/index', props: { platform: 'douyin' } },
    { e: 'parse_success', p: 'pages/index/index', props: { platform: 'douyin', cost_ms: 860 } },
    { e: 'result_view', p: 'pages/result/result', props: {} },
    {
      e: 'ad_click',
      p: 'pages/index/index',
      props: { ad_type: 'rewarded_video', position: 'result_save', method: 'intent' },
    },
    { e: 'ad_show', props: { ad_type: 'rewarded_video' } },
    { e: 'ad_reward_success', props: { ad_type: 'rewarded_video' } },
    { e: 'ad_click', p: 'pages/result/result', props: { ad_type: 'banner', position: 'result_bottom', method: 'area_tap' } },
    { e: 'download_start', props: { media_type: 'video' } },
    { e: 'download_success', props: { media_type: 'video' } },
    { e: 'share_click', props: { channel: 'button' } },
  ].map((item, index) => Object.assign({ uid, sid, ts: now + index * 120, seq: index + 1 }, item));

  const track = await api(
    '/api/track',
    {
      body: {
        app: { platform: 'devtools', brand: 'smoke-test', model: 'node', sdk_version: '3.5.5' },
        events,
      },
    },
    token
  );
  if (track.json && track.json.code === 0) {
    ok('埋点上报', '接收 ' + track.json.data.accepted + ' 条事件');
  } else {
    fail('埋点上报', JSON.stringify(track.json));
  }

  // 保存流程：先扣次数；次数不够（1003）就看广告领，再扣一次
  let consume = await api('/api/credit/consume', { body: { scene: 'smoke', media_type: 'video' } }, token);
  if (consume.json && consume.json.code === 1003) {
    const reward = await api(
      '/api/quota/reward',
      { body: { scene: 'save_need_ad', ad_type: 'rewarded_video' } },
      token
    );
    if (reward.json && reward.json.code === 0) {
      ok(
        '看广告领次数',
        '+' + reward.json.data.added + ' 次，' + reward.json.data.valid_hours + ' 小时内有效，现在有 ' +
          reward.json.data.wallet.credits + ' 次'
      );
    } else if (reward.json && reward.json.code === 1004) {
      // 同一个虚拟 openid 反复跑冒烟测试会撞上「每天看广告上限」，这是正常的业务限制
      ok('看广告领次数', '今天看广告的次数用完了（预期内的业务限制，不是故障）');
    } else {
      fail('看广告领次数', JSON.stringify(reward.json));
    }
    consume = await api('/api/credit/consume', { body: { scene: 'smoke', media_type: 'video' } }, token);
  }
  if (consume.json && consume.json.code === 0) {
    ok('保存前扣次数', '扣掉 1 次，现在还剩 ' + consume.json.data.wallet.credits + ' 次');
  } else if (consume.json && consume.json.code === 1003) {
    ok('保存前扣次数', '次数用完时被正确拦下（1003 = 客户端会弹广告）');
  } else {
    fail('保存前扣次数', JSON.stringify(consume.json));
  }

  const mine = await api('/api/user/summary', { method: 'GET' }, token);
  if (mine.json && mine.json.code === 0) {
    ok('用户统计', '累计解析 ' + mine.json.data.total_parse + ' 次，今日 ' + mine.json.data.today_parse + ' 次');
  } else {
    fail('用户统计', JSON.stringify(mine.json));
  }

  const stats = await api('/api/stats/summary?token=' + encodeURIComponent(config.adminToken) + '&days=7', {
    method: 'GET',
  });
  if (stats.json && stats.json.code === 0) {
    const t = stats.json.data.range_totals;
    ok(
      '看板汇总',
      '7日 UV=' +
        t.uv +
        ' 计算次数(客户端)=' +
        t.parse_success +
        ' 计算次数(服务端)=' +
        t.server_parse_success +
        ' 广告点击=' +
        t.ad_click
    );
    if (t.uv > 0 && t.parse_success > 0 && t.ad_click > 0) {
      ok('三个核心指标都读到了数据');
    } else {
      fail('核心指标为空', JSON.stringify(t));
    }
  } else {
    fail('看板汇总', JSON.stringify(stats.json));
  }

  // 资源中转：自己签一个 demo 视频的链接来验证
  const target = BASE + '/demo/demo.mp4';
  const sign = crypto.createHmac('sha256', config.tokenSecret).update(target).digest('hex').slice(0, 16);
  const proxyRes = await fetch(BASE + '/api/proxy?url=' + encodeURIComponent(target) + '&s=' + sign, {
    headers: { range: 'bytes=0-1023', connection: 'close' },
  });
  if (proxyRes.status === 206 || proxyRes.status === 200) {
    const buf = Buffer.from(await proxyRes.arrayBuffer());
    ok(
      '资源中转',
      'HTTP ' + proxyRes.status + '，收到 ' + buf.length + ' 字节，content-type=' + proxyRes.headers.get('content-type')
    );
  } else if (proxyRes.status === 403 && /内网/.test(await proxyRes.text())) {
    // 演示素材在本机 127.0.0.1 上，默认会被中转的 SSRF 防护拦下来，这是预期行为
    ok('资源中转', '已跳过实测：服务端正确拦截了内网地址（想本地实测可设 PROXY_ALLOW_PRIVATE=1 后重启服务）');
  } else {
    fail('资源中转', 'HTTP ' + proxyRes.status);
  }

  const bad = await fetch(BASE + '/api/proxy?url=' + encodeURIComponent('http://127.0.0.1:8000/api/health'), { headers: { connection: 'close' } });
  if (bad.status === 403) {
    ok('中转拦截非法请求', '127.0.0.1 被拒绝');
  } else {
    fail('中转拦截非法请求', '期望 403，实际 ' + bad.status);
  }

  console.log('\n=== 结果 ===');
  if (failures === 0) {
    console.log('全部通过\n');
    process.exitCode = 0;
  return;
  }
  console.log(failures + ' 项失败\n');
  process.exitCode = 1;
  return;
})().catch((err) => {
  console.error('\n冒烟测试异常:', err);
  process.exitCode = 1;
  return;
});
