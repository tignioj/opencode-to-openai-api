FROM node:24-alpine

ARG OPENCODE_VERSION=1.18.29
RUN apk add --no-cache libgcc libstdc++ ripgrep \
    && npm install --global "opencode-ai@${OPENCODE_VERSION}" \
    && opencode --version

WORKDIR /app
COPY package.json ./
COPY src ./src

ENV HOST=0.0.0.0 \
    PORT=10000 \
    OPENCODE_BASE_URL=http://127.0.0.1:4096 \
    OPENCODE_DIRECTORY=/workspace \
    CLEANUP_SESSIONS=true

EXPOSE 10000
VOLUME ["/workspace", "/root/.config/opencode", "/root/.local/share/opencode"]
CMD ["node", "src/supervisor.js"]
