# 微信云托管「绑定代码仓库」时用的构建文件：仓库根目录要有 Dockerfile
# 真正的服务代码在 server/ 目录里，这里整体拷进镜像
# 注意：仓库里没有 server/.env（含密钥，已被 .gitignore 排除），
#       所以解析接口、口令这些必须配在云托管控制台的「环境变量」里，见 docs/上线检查清单.md
FROM node:20-alpine

WORKDIR /usr/src/app

# 先把 package.json 单独拷进来装依赖：这样改代码时不会每次都重新装包（构建更快）
# mysql2 是「可选依赖」：它只用来把数据存进 MySQL，装不上也不影响服务启动，
# 只是会退回本地文件存储（容器重新发布会丢数据）。装没装上看 /api/health 的 storage 字段。
COPY server/package.json ./
RUN npm install --omit=dev --no-audit --no-fund --registry=https://registry.npmmirror.com \
    || echo "⚠ mysql2 没装上，将退回本地文件存储"

COPY server/ ./

# 云托管默认把流量打到容器的 80 端口
ENV PORT=80
EXPOSE 80

CMD ["node", "index.js"]
