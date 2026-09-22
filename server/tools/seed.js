/**
 * 造演示数据：生成最近 N 天的模拟埋点，方便在没有真实用户时先看板长什么样
 * 用法：node tools/seed.js [天数]   例如 node tools/seed.js 14
 * 注意：会直接写进 data/ 目录，和真实数据混在一起，正式上线前记得删掉 data 目录重新开始。
 */
const path = require('path');
const store = require(path.join(__dirname, '..', 'src', 'store'));

const DAYS = Math.max(1, Math.min(60, Number(process.argv[2]) || 14));

// 固定种子的伪随机，保证每次生成的数据形态一致（方便对比）
let seed = 20260922;
function rnd() {
  seed = (seed * 1103515245 + 12345) % 2147483648;
  return seed / 2147483648;
}
function pick(list) {
  return list[Math.floor(rnd() * list.length)];
}
function int(min, max) {
  return Math.floor(min + rnd() * (max - min + 1));
}

const PLATFORMS = ['douyin', 'douyin', 'douyin', 'kuaishou', 'kuaishou', 'xiaohongshu', 'bilibili', 'weibo', 'other'];
const SCENES = [
  [1001, '发现栏小程序主入口'],
  [1007, '单人聊天会话中的小程序消息卡片'],
  [1008, '群聊会话中的小程序消息卡片'],
  [1011, '扫描二维码'],
  [1047, '扫描小程序码'],
  [1058, '公众号文章'],
  [1092, '微信聊天主界面下拉「最近使用」'],
];
const PAGES = ['pages/index/index', 'pages/result/result', 'pages/mine/mine', 'pages/history/history'];

const events = [];
let eventSeq = 0;

function push(uid, sid, ts, e, p, props) {
  eventSeq += 1;
  events.push({ e, uid, sid, ts, seq: eventSeq, p: p || '', props: props || {} });
}

const now = new Date();
// 依次造每一天
for (let d = DAYS - 1; d >= 0; d -= 1) {
  const day = new Date(now.getTime() - d * 86400000);
  // 越近的天用户越多，模拟自然增长
  const factor = 1 + (DAYS - d) / DAYS;
  const userCount = Math.max(3, Math.round((18 + rnd() * 14) * factor));

  for (let u = 0; u < userCount; u += 1) {
    const isNew = rnd() < 0.42;
    const uid = 'u_seed_' + day.toISOString().slice(0, 10).replace(/-/g, '') + '_' + u;
    if (!isNew && d === DAYS - 1 && rnd() < 0.25) continue; // 老用户不一定每天都来

    const sid = 's_seed_' + d + '_' + u;
    const baseHour = 9 + Math.floor(rnd() * 14);
    const base = new Date(day);
    base.setHours(baseHour, int(0, 59), int(0, 59), 0);
    const start = base.getTime();
    const scene = pick(SCENES);
    const fromShare = rnd() < 0.18;

    push(uid, sid, start, 'app_launch', '', {
      scene: scene[0],
      scene_name: scene[1],
      cold_start: true,
      from_uid: fromShare ? 'u_seed_share' : '',
      from: fromShare ? 'share' : '',
    });
    push(uid, sid, start + 800, 'page_view', PAGES[0], { path: PAGES[0] });

    // 有的人只是看看就走了
    if (rnd() < 0.18) {
      push(uid, sid, start + 9000, 'page_leave', PAGES[0], { stay_sec: 9 });
      continue;
    }

    // 解析免费，所以想解析几次就几次；次数只在「保存到相册」时才花
    const parseTimes = rnd() < 0.45 ? 1 : int(2, 6);
    let credits = 0; // 保存次数（看广告领的）
    let rewarded = false; // 今天有没有领过

    for (let k = 0; k < parseTimes; k += 1) {
      const platform = pick(PLATFORMS);
      const t0 = start + 10000 + k * 45000;
      push(uid, sid, t0, 'parse_submit', PAGES[0], { platform, has_url: true, credits });
      push(uid, sid, t0 + 120, 'parse_start', PAGES[0], { platform });

      const success = rnd() < 0.86;
      const cost = int(700, 4200);
      if (success) {
        push(uid, sid, t0 + cost, 'parse_success', PAGES[0], { platform, cost_ms: cost, media_type: 'video' });
        push(uid, sid, t0 + cost + 400, 'result_view', PAGES[1], { platform, media_type: 'video' });
        push(uid, sid, t0 + cost + 900, 'result_play', PAGES[1], {});

        if (rnd() < 0.62) {
          // 要保存了：次数不够就先弹激励视频
          let blocked = false;
          let t = t0 + cost + 1500;
          if (credits <= 0) {
            if (!rewarded) {
              rewarded = true;
              push(uid, sid, t, 'save_need_ad', PAGES[1], { position: 'result_save' });
              push(uid, sid, t + 1200, 'ad_click', PAGES[1], {
                ad_type: 'rewarded_video',
                position: 'result_save',
                method: 'intent',
              });
              push(uid, sid, t + 1500, 'ad_show', PAGES[1], { ad_type: 'rewarded_video' });
              const watched = rnd() < 0.8;
              push(uid, sid, t + 33000, 'ad_close', PAGES[1], {
                ad_type: 'rewarded_video',
                is_ended: watched,
              });
              if (watched) {
                push(uid, sid, t + 33200, 'ad_reward_success', PAGES[1], { ad_type: 'rewarded_video' });
                push(uid, sid, t + 33500, 'reward_claim_success', PAGES[1], { added: 10, scene: 'save' });
                credits += 10;
                t += 34000;
              } else {
                blocked = true;
              }
            } else {
              blocked = true;
            }
          }

          push(uid, sid, t, 'download_start', PAGES[1], { media_type: 'video' });
          if (blocked) {
            push(uid, sid, t + 800, 'download_fail', PAGES[1], { reason: 'need_ad' });
          } else if (rnd() < 0.9) {
            credits -= 1;
            push(uid, sid, t + 1100, 'download_success', PAGES[1], { media_type: 'video' });
          } else {
            push(uid, sid, t + 1100, 'download_fail', PAGES[1], { reason: 'auth deny' });
          }
        }
        if (rnd() < 0.2) {
          push(uid, sid, t0 + cost + 3000, 'copy_link', PAGES[1], { platform });
        }
      } else {
        push(uid, sid, t0 + cost, 'parse_fail', PAGES[0], { platform, code: 1002, msg: '解析失败', cost_ms: cost });
      }

      // banner 曝光 + 少量区域点击
      if (rnd() < 0.7) {
        push(uid, sid, t0 + 2000, 'ad_load', PAGES[0], { ad_type: 'banner', position: 'home_bottom' });
        push(uid, sid, t0 + 2050, 'ad_show', PAGES[0], { ad_type: 'banner', position: 'home_bottom' });
        if (rnd() < 0.06) {
          push(uid, sid, t0 + 2400, 'ad_click', PAGES[0], {
            ad_type: 'banner',
            position: 'home_bottom',
            method: 'area_tap',
          });
        }
      }
    }

    if (rnd() < 0.12) {
      push(uid, sid, start + 200000, 'share_click', PAGES[1], { channel: 'button' });
    }
  }
}

const app = { platform: 'ios', brand: 'Apple', model: 'iPhone 15', sdk_version: '3.5.5', user_id: '' };
const result = store.writeEvents(events, app);
store.flush();

console.log('已生成 ' + result.accepted + ' 条事件，覆盖 ' + result.days.length + ' 天：' + result.days.join(', '));
console.log('打开 http://127.0.0.1:' + require('../src/config').port + '/admin 就能看到数据了');
