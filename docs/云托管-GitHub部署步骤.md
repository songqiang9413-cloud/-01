# 云托管 + GitHub 部署步骤（照着点就行）

> 适用场景：代码已经托管在 GitHub，微信云托管直接「绑定代码仓库」，以后改代码 `git push` 就能重新发布。
> 本文件不含任何密钥；所有密钥都在云托管控制台的「环境变量」里配。

---

## 一、仓库准备（已完成，留档备查）

- 仓库地址：`https://github.com/songqiang9413-cloud/-01.git`
- 分支：`main`
- 仓库根目录有 `Dockerfile`，这是云托管构建用的入口文件
  - 它做三件事：`COPY server/ ./`（把后端代码拷进镜像）、`ENV PORT=80`（云托管默认把流量打到 80 端口）、`CMD ["node","index.js"]`
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

> 改完环境变量需要**重新发布**一次才生效。

### 3. 验证

- 浏览器打开 `https://<你的公网域名>/api/health`，应返回 `{"ok":true,...,"provider":"http"}`
- 浏览器打开 `https://<你的公网域名>/admin?token=<ADMIN_TOKEN>`，能看到 UV / 计算次数 / 广告点击看板
- 在微信开发者工具里，把 `miniprogram/config/index.js` 的 `CLOUD.envId` / `CLOUD.service` 填对，粘一个链接点解析，能出视频即可

---

## 三、小程序端要跟着改的地方

- `miniprogram/config/index.js` → `CLOUD.envId` 和 `CLOUD.service`（填好就走内网专线，**免域名、免备案**）
- 开通流量主后，把 `adUnits` 里的 `adunit-0000...` 换成真实广告位 ID，否则激励视频放不出来（放不出来时程序会**放行保存**，不卡用户）
- 微信公众平台 → 开发管理 → 服务器域名 → **downloadFile 合法域名**：把 `docs/微信合法域名-200个.txt` 里的 200 行粘进去（云托管调用不走域名白名单，但保存素材直连 CDN 需要）

---

## 四、已知事项

- **容器没有持久硬盘**：`server/data/` 里的埋点、UV、用户余额在每次重新发布后会清空。
  要长期保留，需要把存储从本地文件换成云托管自带的 MySQL（环境变量 `MYSQL_ADDRESS` / `MYSQL_USERNAME` / `MYSQL_PASSWORD`）——TODO。
- **服务商点数**：解析按次扣服务商余额，余额为 0 时接口返回 `300`，看板会红字提示「服务商点数不足」，去服务商后台充值即可。
