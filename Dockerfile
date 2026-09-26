FROM node:24-alpine
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install --omit=dev
COPY server.js storage.js index.html PROTOCOL.md ./
ENV PORT=8099
EXPOSE 8099
CMD ["node", "server.js"]
