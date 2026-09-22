# 云托管 + GitHub 部署步骤（照着点就行）

> 适用场景：代码已经托管在 GitHub，微信云托管直接「绑定代码仓库」，以后改代码 `git push` 就能重新发布。
> 本文件不含任何密钥；所有密钥都在云托管控制台的「环境变量」里配。

---

## 一、仓库准备（已完成，留档备查）

- 仓库地址：`https://github.com/songqiang9413-cloud/-01.git`
- 分支：`main`
- 仓库根目录有 `Dockerfile`，这是云托管构建用的入口文件
  - 它做四件事：`COPY server/package.json` + `npm install`（装可选的 mysql2）、`COPY server/ ./`（把后端代码拷进镜像）、
    `ENV PORT=80`（云托管默认把流量打到 80 端口）、`CMD ["node","index.js"]`
  - `mysql2` 声明在 `optionalDependencies` 里：npm 拉包失败也不会让构建失败，程序会退回本地文件存储继续跑
- 仓库里**没有** `server/.env`（已加进 `.gitignore`），所以密钥必须配在控制台环境变量里，否则解析接口用不了

---

## 二、控制台操作（约 5 分钟）

### 1. 绑定代码仓库

1. 打开 [微信云托管控制台](https://console.cloud.tencent.com/tcb)
2. 选环境 `prod-d0gj2but32ea37fed` → 服务管理 → 服务 `express-jt32`
3. 点「部署发布」→「选择方式」选 **绑定代码仓库**
4. 首次会要求授权 GitHub：点「去授权」，在新窗口里点 **Install & Authorize**，把仓库 `-01` 授权给云托管
5. 回到控制台，填：
   - 仓库：`songqiang9413-cloud/-01`
   - 分支：`main`
   - 构建目录：留空 / `/`（根目录，Dockerfile 就在这）
   - Dockerfile 路径：`Dockerfile`
6. 点「发布」，等 2~3 分钟（拉代码 → 构建镜像 → 部署）

### 2. 配环境变量（关键，不配解析会失败）

服务设置 → 环境变量 → 逐条添加，共 7 条（值见 `dist/云托管环境变量-贴到控制台.txt`）：

| 变量名 | 说明 |
| --- | --- |
| `PARSE_PROVIDER` | 固定 `http`（走第三方解析服务商，不自建） |
| `PARSE_API_URL` | 服务商接口，末尾必须保留 `{url}` 占位符 |
| `PARSE_API_METHOD` | 固定 `GET` |
| `PARSE_FIELD_VIDEO` | 从响应里取视频地址的路径，固定 `data.video` |
| `PROXY_DIRECT_HOSTS` | 固定 `*`：云托管没有备案域名做中转，素材一律直连 CDN |
| `TOKEN_SECRET` | 用户登录令牌的加密串，48 位随机字符 |
| `ADMIN_TOKEN` | 看板口令，别泄露 |
| `WX_APPID` / `WX_SECRET` | 小程序 AppID / AppSecret（公众平台 → 开发管理 → 开发设置）。配了才能用 `wx.login` 换 openid |
| `TRUST_CLOUD_OPENID` | `0` = 不信任请求头里的 openid，只认自己签发的登录令牌（**公网访问开着时必配 0**，否则别人伪造 `x-wx-openid` 头就能白刷你的解析费） |

> ⚠️ **上线前必须确认**：`TRUST_CLOUD_OPENID=0` + `WX_APPID`/`WX_SECRET` 三者要一起配。
> 只配 `WX_APPID`/`WX_SECRET`、不关信任，等于门开着还挂了把锁。
> 自检方法：不带任何令牌、只往请求头塞一个 `x-wx-openid` 调 `/api/quota`，
> 返回 401 才算安全，返回 200 就是还能被白刷。

以下两组按需添加（详见 `dist/云托管环境变量-贴到控制台.txt`）：

| 变量名 | 说明 |
| --- | --- |
| `MYSQL_ADDRESS` / `MYSQL_USERNAME` / `MYSQL_PASSWORD` | 绑定云托管 MySQL 后平台一般会自动注入。不配的话每次重新发布，UV / 计算次数 / 广告点击 / 用户余额都会清零 |
| `AD_UNIT_REWARDED` | 激励视频广告位（**等「流量主」开通后再填**，这是收益来源） |
| `AD_UNIT_BANNER_HOME` / `AD_UNIT_BANNER_RESULT` / `AD_UNIT_INTERSTITIAL` | 可选，其他广告位 |
| `AD_ENABLED` | `0` 可以一键关掉全部广告逻辑 |

> 广告位放在服务端的好处：换广告位只要「改环境变量 + 重新发布」，**不用重新提交小程序审核**。
> 小程序启动时会调 `GET /api/client/config` 把这些值拉过去。

> 改完环境变量需要**重新发布**一次才生效。

### 3. 验证

- 浏览器打开 `https://<你的公网域名>/api/health`，应返回 `{"ok":true,...,"provider":"http"}`
  - 同时看 `"storage"`：`mysql` = 数据存进数据库了；`file` = 只在容器本地（重新发布会丢），看 `db_error` 排查
- 浏览器打开 `https://<你的公网域名>/admin?token=<ADMIN_TOKEN>`，能看到 UV / 计算次数 / 广告点击看板
- 在微信开发者工具里，把 `miniprogram/config/index.js` 的 `CLOUD.envId` / `CLOUD.service` 填对，粘一个链接点解析，能出视频即可
- 本机自检（不用数据库也能跑）：`cd server && node tools/test-mysql.js`

---

## 三、小程序端要跟着改的地方

- `miniprogram/config/index.js` → `CLOUD.envId` 和 `CLOUD.service`（填好就走内网专线，**免域名、免备案**）
- 开通流量主后，把 `adUnits` 里的 `adunit-0000...` 换成真实广告位 ID，否则激励视频放不出来（放不出来时程序会**放行保存**，不卡用户）
- 微信公众平台 → 开发管理 → 服务器域名 → **downloadFile 合法域名**：把 `docs/微信合法域名-200个.txt` 里的 200 行粘进去（云托管调用不走域名白名单，但保存素材直连 CDN 需要）

---

## 四、已知事项

- **容器没有持久硬盘**：不配 MySQL 的话，`server/data/` 里的埋点、UV、用户余额在每次重新发布后会清空。
  配了 `MYSQL_*` 就会存进数据库（一张 `app_store` 表，key 是相对 data 目录的文件路径），重新发布不丢。
  原始事件流水 `events/*.jsonl` 仍然只落本地磁盘 —— 它是排查用的日志，量最大、不需要长期保留。
- **服务商点数**：解析按次扣服务商余额，余额为 0 时接口返回 `300`，看板会红字提示「服务商点数不足」，去服务商后台充值即可。
