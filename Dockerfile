FROM node:24-alpine
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install --omit=dev
COPY server.js storage.js mcp.js wake.js worlds.js rules.js index.html world-viewer.js world-viewer.css PROTOCOL.md WORLDS.md ./
ENV PORT=8099
EXPOSE 8099
CMD ["node", "server.js"]
