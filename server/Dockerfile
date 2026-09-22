# 微信云托管用的镜像
# 本项目零 npm 依赖（不用 npm install），所以构建很快，十几秒就完事
FROM node:20-alpine

WORKDIR /usr/src/app
COPY . .

# 有些上传方式会跳过 .env 这类隐藏文件，所以再放一份 env.cloud 兜底
RUN if [ ! -f .env ] && [ -f env.cloud ]; then cp env.cloud .env; fi

# 云托管默认把流量打到容器的 80 端口（这个值会覆盖 .env 里的 PORT）
ENV PORT=80
EXPOSE 80

CMD ["node", "index.js"]