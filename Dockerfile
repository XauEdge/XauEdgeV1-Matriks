FROM node:22.23.2-alpine3.24
ENV NODE_ENV=production PORT=8080 DATA_DIR=/data
WORKDIR /app
COPY package.json ./
COPY src ./src
COPY mt5 ./mt5
RUN mkdir -p /data && chown -R node:node /app /data
USER node
EXPOSE 8080
CMD ["node", "src/server.js"]
