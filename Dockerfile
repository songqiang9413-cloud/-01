# 微信云托管「绑定代码仓库」时用的构建文件：仓库根目录要有 Dockerfile
# 真正的服务代码在 server/ 目录里，这里整体拷进镜像
# 注意：仓库里没有 server/.env（含密钥，已被 .gitignore 排除），
#       所以解析接口、口令这些必须配在云托管控制台的「环境变量」里，见 docs/上线检查清单.md
FROM node:20-alpine

WORKDIR /usr/src/app
COPY server/ ./

# 云托管默认把流量打到容器的 80 端口
ENV PORT=80
EXPOSE 80

CMD ["node", "index.js"]
