/**
 * 解析调试工具 —— 平台改版时用这个第一时间排查
 * ------------------------------------------------------------------
 * 用法：
 *   node tools/test-parse.js "https://v.douyin.com/xxxxx/"
 *   node tools/test-parse.js "链接" --provider=selfhosted   指定服务商
 *   node tools/test-parse.js "链接" --download              顺便验证地址能不能下下来
 *   node tools/test-parse.js --selftest                     用内置样本测解析逻辑（不联网）
 * ------------------------------------------------------------------
 */
const path = require('path');
const config = require(path.join(__dirname, '..', 'src', 'config'));
const providers = require(path.join(__dirname, '..', 'src', 'providers'));
const platform = require(path.join(__dirname, '..', 'src', 'platform'));

const args = process.argv.slice(2);
const flags = args.filter((a) => a.startsWith('--'));
const inputs = args.filter((a) => !a.startsWith('--'));
const providerFlag = (flags.find((f) => f.startsWith('--provider=')) || '').split('=')[1];

function fail(msg) {
  console.error('[X] ' + msg);
  process.exitCode = 1;
}

/* ------------------------- 离线自测：解析逻辑 ------------------------- */
function selftest() {
  const douyin = require(path.join(__dirname, '..', 'src', 'providers', 'selfhosted', 'douyin'));
  let pass = 0;
  let total = 0;
  const check = (name, actual, expected) => {
    total += 1;
    if (actual === expected) {
      pass += 1;
      console.log('  [OK] ' + name);
    } else {
      console.log('  [X] ' + name + '  期望 ' + expected + '，实际 ' + actual);
      process.exitCode = 1;
    }
  };

  console.log('1) 从链接里识别作品 ID');
  check('分享短链', douyin.pickItemId('https://v.douyin.com/iRabcdef/'), '');
  check('分享页长链', douyin.pickItemId('https://www.iesdouyin.com/share/video/7588908199673037915/?region=CN'), '7588908199673037915');
  check('网页视频页', douyin.pickItemId('https://www.douyin.com/video/7372484719360749321'), '7372484719360749321');
  check('modal_id 参数', douyin.pickItemId('https://www.douyin.com/user/xxx?modal_id=7588908199673037915'), '7588908199673037915');

  console.log('2) 带水印地址 → 无水印地址');
  check(
    'playwm 替换',
    douyin.toNoWatermark('https://aweme.snssdk.com/aweme/v1/playwm/?video_id=v2800fgi0000&ratio=720p&line=0'),
    'https://aweme.snssdk.com/aweme/v1/play/?video_id=v2800fgi0000&ratio=720p&line=0'
  );
  check(
    '本来就是 play 的不动',
    douyin.toNoWatermark('https://aweme.snssdk.com/aweme/v1/play/?video_id=abc'),
    'https://aweme.snssdk.com/aweme/v1/play/?video_id=abc'
  );

  console.log('3) 从分享页 HTML 里抠 _ROUTER_DATA');
  const sample = '<html><script>window._ROUTER_DATA = {"loaderData":{"video_(id)/page":{"videoInfoRes":{"item_list":[{"desc":"测试 \\"引号\\" 和 {花括号}"}]}}}};</script></html>';
  const data = douyin.extractRouterData(sample);
  check('能解析出 JSON', !!data, true);
  check('能取到嵌套的标题', data && data.loaderData['video_(id)/page'].videoInfoRes.item_list[0].desc, '测试 "引号" 和 {花括号}');
  check('没有 _ROUTER_DATA 时返回 null', douyin.extractRouterData('<html></html>'), null);

  console.log('4) 平台识别');
  check('抖音', platform.detect('https://v.douyin.com/abc/'), 'douyin');
  check('快手', platform.detect('https://v.kuaishou.com/abc'), 'kuaishou');
  check('小红书', platform.detect('https://xhslink.com/abc'), 'xiaohongshu');

  console.log('\n' + (pass === total ? '全部通过 ' + pass + '/' + total : pass + '/' + total + ' 通过'));
}

/* ------------------------- 联网实测 ------------------------- */
async function live(url) {
  // 允许用 --provider=xxx 临时指定服务商，方便对比自建和第三方
  if (providerFlag) config.parse.provider = providerFlag;
  console.log('输入链接 :', url);
  console.log('平台识别 :', platform.detect(url), '(' + platform.name(platform.detect(url)) + ')');
  console.log('主服务商 :', providerFlag || config.parse.provider);
  if (config.parse.fallbackProvider) console.log('兜底服务商:', config.parse.fallbackProvider);
  console.log('');

  const started = Date.now();
  try {
    const result = await providers.parse({ url, baseUrl: 'http://127.0.0.1:' + config.port });
    console.log('解析成功，耗时 ' + (Date.now() - started) + 'ms');
    console.log('  服务商  :', result.provider + (result.downgraded ? '（已降级）' : ''));
    console.log('  类型    :', result.type);
    console.log('  标题    :', (result.title || '(空)').slice(0, 60));
    console.log('  作者    :', result.author || '(空)');
    console.log('  封面    :', (result.cover || '(空)').slice(0, 110));
    console.log('  无水印  :', (result.url || '').slice(0, 140));
    if (result.extra && result.extra.watermarked_url) {
      console.log('  （对比）带水印地址:', result.extra.watermarked_url.slice(0, 120));
    }

    if (flags.includes('--download')) {
      console.log('\n验证地址是否可下载…');
      const res = await fetch(result.url, {
        headers: { 'user-agent': 'Mozilla/5.0', referer: 'https://www.douyin.com/' },
        signal: AbortSignal.timeout(20000),
      });
      const size = Number(res.headers.get('content-length')) || 0;
      console.log(
        '  HTTP ' + res.status + ' | ' + (res.headers.get('content-type') || '') + ' | ' +
        (size ? (size / 1048576).toFixed(2) + 'MB' : '大小未知') + ' | 最终域名 ' + new URL(res.url).host
      );
      if (res.body) res.body.cancel().catch(() => {});
      if (res.status >= 400) fail('地址不可下载');
    }
    console.log('\n成功');
  } catch (err) {
    fail(err.message);
    if (err.raw) console.log('    细节:', err.raw);
    console.log('\n排查建议：');
    if ((providerFlag || config.parse.provider) === 'http') {
      console.log('  1) 对照服务商文档，检查 .env 里的 PARSE_API_URL / PARSE_API_METHOD / PARSE_API_HEADERS / PARSE_API_BODY');
      console.log('  2) 最常见的坑：PARSE_FIELD_VIDEO 填错了，从返回 JSON 里找不到视频直链');
      console.log('      —— 让服务商给你一段「成功返回的 JSON 示例」，照着数路径（支持 a.b.c 这种写法）');
      console.log('  3) 想确认是自己配置的问题还是服务商的问题：--provider=mock 能通过就说明接口链路本身没问题');
    } else {
      console.log('  1) 先用 --selftest 确认解析逻辑本身没问题');
      console.log('  2) 如果只是自建失败：可能是平台改版，看 src/providers/selfhosted/douyin.js 顶部的说明');
      console.log('  3) 临时救急：在 .env 里把 PARSE_PROVIDER 换成 http（第三方接口），或配 PARSE_FALLBACK_PROVIDER=http 自动兜底');
    }
  }
}

if (flags.includes('--selftest')) {
  console.log('=== 离线自测（不联网）===\n');
  selftest();
} else if (!inputs.length) {
  console.log('用法：node tools/test-parse.js "<分享链接>" [--provider=selfhosted] [--download]');
  console.log('     node tools/test-parse.js --selftest');
} else {
  console.log('=== 解析实测 ===\n');
  live(inputs[0]);
}
