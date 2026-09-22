# 短视频去水印小程序

一套可以直接跑起来的微信小程序 + 后端，**埋点（UV / 计算次数 / 广告点击）已经接好**。

参考项目：[WYQilin/remove-water-mark-mp](https://github.com/WYQilin/remove-water-mark-mp)（2020 年的老项目，只借鉴了页面流程，代码全部重写，原因见文末）。

---

## 30 秒跑起来

```bash
# 1. 启动后端（零依赖，不用 npm install，需要 Node 18+）
cd server
node index.js

# 2. 另开一个终端，跑一遍自检（可选，但很推荐）
cd server
node tools/smoke-test.js
# 想真跑一次解析（默认已是自建解析）：SMOKE_URL="https://www.douyin.com/video/作品ID" node tools/smoke-test.js
```

```
# 3. 打开微信开发者工具
导入项目 → 选择 miniprogram 目录 → AppID 选「测试号」
详情 → 本地设置 → 勾选「不校验合法域名」
```

粘一个抖音链接（整段分享文案也行）点「一键去水印」，能出视频就说明整条链路通了
（默认已开自建解析，不用买接口）。

数据看板：<http://127.0.0.1:8000/admin?token=admin123>

> 想看满数据的看板长什么样：`cd server && node tools/seed.js 14`（造 14 天模拟数据）

---

## 目录结构

```
103去水印小程序/
├── miniprogram/                     微信小程序（原生，无需构建）
│   ├── app.js / app.json / app.wxss 入口、全局样式
│   ├── config/index.js              ★ 环境、广告位、业务参数都在这
│   ├── utils/
│   │   ├── tracker.js               ★ 埋点 SDK：队列 / 批量上报 / 重试 / 离线补发
│   │   ├── ad.js                    ★ 广告封装：激励视频 / 插屏 / Banner + 广告埋点
│   │   ├── request.js               网络封装：自动登录、401 重试
│   │   ├── device.js                设备信息 & 场景值兼容层
│   │   ├── storage.js / util.js     本地存储、通用工具
│   ├── components/privacy-popup/    隐私授权弹窗（保存相册必须）
│   └── pages/
│       ├── index/                   首页：粘贴链接 → 解析
│       ├── result/                  结果页：预览 / 保存相册 / 复制直链
│       ├── mine/                    我的：次数、头像昵称、入口
│       └── history/                 解析记录（存本地）
│
├── tools/                           辅助脚本
│   ├── check-miniprogram.js         小程序静态检查（事件绑定 / require / 资源是否齐全）
│   ├── reset-data.js                清空 server/data（想重新开始统计时用）
│   └── gen_images.py                生成 tabBar 图标和默认头像（Pillow）
│
├── server/                          Node.js 后端（零依赖）
│   ├── index.js                     启动入口 + 静态资源
│   ├── .env.example                 ★ 复制成 .env 再改
│   ├── src/
│   │   ├── config.js                配置（env / 业务参数 / 解析服务商 / 中转）
│   │   ├── store.js                 ★ 数据层：事件落盘 + 按天汇总 + UV 去重 + 次数配额
│   │   ├── auth.js                  code2session + token 签名
│   │   ├── router.js                路由
│   │   ├── handlers/                login / parse / quota / track / stats / proxy
│   │   └── providers/               解析服务商：mock（演示）/ http（第三方接口）
│   ├── admin/index.html             数据看板（纯手写，不依赖任何 CDN）
│   ├── tools/smoke-test.js          端到端自检
│   ├── tools/seed.js                造演示数据
│   └── data/                        运行后自动生成
│
└── docs/
    ├── 埋点方案.md                  ★ 指标体系、事件字典、上报机制、常见坑
    └── 上线检查清单.md               ★ 从注册到提审的完整清单
```

---

## 它长什么样

```
┌─────────────────────────────┐
│  小程序                      │
│  首页 → 粘贴链接 → 一键去水印  │
│         ↓                    │
│  结果页 → 预览 / 保存相册      │
│         ↓                    │
│  次数用完 → 看激励视频加次数    │
│                             │
│  tracker.js 把每一步都记下来   │
└──────────┬──────────────────┘
           │ 批量上报 POST /api/track
           ▼
┌─────────────────────────────┐
│  后端 (Node)                 │
│  /api/parse  解析（权威计数） │
│  /api/track  埋点收集         │
│  /api/proxy  资源中转         │
│         ↓                    │
│  events/*.jsonl  原始流水     │
│  rollup/*.json   按天汇总     │
└──────────┬──────────────────┘
           ▼
    /admin 数据看板
    UV · 计算次数 · 广告点击 · 漏斗
```

---

## 三个核心指标怎么看

| 指标 | 定义 | 看板位置 |
| --- | --- | --- |
| **UV** | 按匿名设备 ID（`uid`）去重，同一台手机一天只算一次 | 首行第一张卡片 |
| **计算次数** | 解析成功的次数。**服务端口径**（无法伪造）和客户端口径对照看 | 第三张卡片 |
| **广告点击** | 微信广告没有点击回调，所以分「用户主动点击入口」和「banner 区域点击」两类统计。现在点击入口就是「结果页点保存」 | 第五张卡片 |

---

## 业务规则（一句话说清）

| 环节 | 收不收费 | 说明 |
| --- | --- | --- |
| 解析 | **免费** | 粘贴链接就能解析、能预览。每人每天上限 `PARSE_DAILY_LIMIT`（默认 100）纯粹是防刷接口费的保险丝 |
| 保存到相册 | **消耗 1 次** | 余额不够时会弹激励视频 |
| 看广告 | **+10 次** | 从看完那一刻起 **24 小时内有效**，过期自动归零；没过期再领则累加并顺延 |

三个参数都在 `server/.env`：`REWARD_PER_AD`（看一次送几次）、`REWARD_VALID_HOURS`（有效期小时）、`MAX_REWARD_PER_DAY`（每天最多看几次广告）。

账户余额存在服务端（`server/data/wallet.json`），扣次数只有一个入口 `POST /api/credit/consume`，所以改前端刷不出次数。

详细的埋点设计（事件字典、上报机制、为什么这么做）见 **[docs/埋点方案.md](docs/埋点方案.md)**。

快速验证埋点有没有生效：

```bash
cd server
node tools/smoke-test.js
# [OK] 看板汇总  7日 UV=... 计算次数(服务端)=... 广告点击=...
```

---

## 常用操作

| 想做什么 | 怎么做 |
| --- | --- |
| 看数据 | `http://127.0.0.1:8000/admin?token=<ADMIN_TOKEN>` |
| 造演示数据 | `cd server && node tools/seed.js 14` |
| 自检接口 | `cd server && node tools/smoke-test.js` |
| 改业务规则 | `server/.env` 里的 `REWARD_PER_AD`（送几次）/ `REWARD_VALID_HOURS`（有效期）/ `MAX_REWARD_PER_DAY`（每天看几次上限） |
| 换解析接口 | `server/.env` 里 `PARSE_PROVIDER`：现在是 `http`（你买的第三方）；`mock` 演示；`selfhosted` 自建（代码还在，没启用） |
| 调解析超时 | `server/.env` 的 `PARSE_TIMEOUT`（服务商要求 60000 毫秒，已配好） |
| 加/改直连域名 | 名单在 `server/data/direct-hosts.txt`，微信后台粘 `docs/微信合法域名-200个.txt`（同一份），改完重启服务 |
| 服务商充值了 | 不用改代码，下一条解析自动恢复；看板「计算次数」卡片会提示点数不足 |
| 测自建解析 | `cd server && node tools/test-parse.js "抖音链接" --download`（平台改版时先用它排查） |
| 测第三方接口 | `cd server && node tools/test-parse.js "抖音链接" --provider=http --download` |
| 填广告位 | `miniprogram/config/index.js` 的 `adUnits` |
| 关掉广告调试 | `miniprogram/config/index.js` 里 `adEnabled: false` |
| 看原始埋点 | `server/data/events/<日期>.jsonl`，一行一条 |
| 检查小程序代码 | `node tools/check-miniprogram.js`（改了页面后跑一下，能查出漏写的方法/资源） |
| 部署到云托管 | `powershell -ExecutionPolicy Bypass -File tools\打包云托管.ps1`，再把 `dist\云托管部署包` 整个上传到云托管控制台 |
| 云托管配置 | `miniprogram/config/index.js` 的 `CLOUD.envId`（环境 ID）+ `CLOUD.service`（服务名）；填了就走内网专线，不用域名 |
| 清空统计数据 | `node tools/reset-data.js`（删掉 server/data，重新开始） |

---

## 和参考项目的区别

参考项目（2020 年）的核心流程是对的，但不少写法现在要么失效、要么会被限制，所以这一版重写了：

| 方面 | 参考项目（2020） | 本项目（2026） |
| --- | --- | --- |
| 用户信息 | `wx.getUserInfo` + `open-type="getUserInfo"` | 已用「头像昵称填写能力」（`open-type="chooseAvatar"` + `type="nickname"`），老接口 2022-10-25 起返回匿名数据 |
| 剪贴板 | 进入首页自动读剪贴板 | 改成点「粘贴链接」按钮再读（`wx.getClipboardData` 现在必须在用户点击事件里调用） |
| 隐私协议 | 无 | 内置隐私授权弹窗 + `__usePrivacyCheck__`，否则保存到相册会被拦 |
| 登录 | 需要用户授权头像才登录 | 静默登录（`wx.login` → openid），不打扰用户 |
| 次数限制 | 只存在本地 storage，改一下就能破解 | 服务端钱包（余额 + 过期时间），扣次数只有一个入口，改前端绕不过去 |
| 解析服务 | 固定 PHP 后端 | 三种可插拔：`http`（**买来的第三方接口，在用**）/ `selfhosted`（自建，代码留着备用）/ `mock`（演示） |
| 广告时机 | 无 | **点保存时才弹激励视频**，看完 +10 次、24 小时内有效；解析本身免费，用户能先看效果再决定看不看广告 |
| 资源下载 | 需要自己搭 nginx 中转 | 内置 `/api/proxy` 中转，支持 Range（视频能拖进度条）、带签名防滥用、拦内网地址防 SSRF |
| **埋点** | **完全没有** | **UV / 计算次数 / 广告点击 全链路埋点 + 网页看板** |
| 后端依赖 | PHP + MySQL | Node 18+，**零 npm 依赖**，`node index.js` 直接跑 |

---

## 几个必须知道的前提

1. **解析靠买来的第三方接口**，配置在 `server/.env`（`PARSE_API_URL` 里带你的 key）。
   这个 key 等于半个密码：`.env` 已被 `.gitignore` 挡住，但你别把带 key 的完整地址外传。
   项目里还留着自建解析的代码（`PARSE_PROVIDER=selfhosted`），哪天第三方涨价或跑路可以切回去。
2. **广告要等有量才能开**。流量主一般要求累计 UV ≥ 1000。
   广告位 ID 还是占位值时（`adunit-0000...`），页面不会渲染广告位，也不会报错；
   把真实的 `adunit-xxx` 填进 `config/index.js` 后广告自动出现。
3. **中转会吃你服务器的带宽**。默认全部走中转；把服务商给的 CDN 域名填进
   `server/data/direct-hosts.txt` 并在微信后台配好 downloadFile 白名单后，命中的域名会直接下载，
   不占你的带宽（没配全也没关系，客户端会自动回退到中转）。量起来后建议换成对象存储 + CDN。
4. **审核有风险**。这类工具位置比较敏感，别用「破解」类表述，页面要有版权合规说明。
   详见 [docs/上线检查清单.md](docs/上线检查清单.md)。

---

## 下一步可以做的

- [ ] 去第三方服务商后台确认套餐额度和超量计费，心里有个数
- [ ] 上线前把 `ADMIN_TOKEN` / `TOKEN_SECRET` 改成随机长串（现在是默认值，谁都能看你的看板）
- [ ] 部署到服务器 + 配置 HTTPS 域名（见上线清单阶段 2）
- [ ] 数据量大了以后把 `server/src/store.js` 换成 SQLite / MySQL（接口不用动，只改这一个文件）
- [ ] 加个「解析失败自动重试一次」的兜底
- [ ] 看板加导出 CSV（`data/events/*.jsonl` 本身就是最好的数据源）
