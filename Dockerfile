FROM node:20-alpine

# SAGE has no native deps — plain Alpine is fine
WORKDIR /app

COPY package*.json ./
RUN npm ci --only=production

COPY . .

# Audit log lives in a volume so it survives restarts
RUN mkdir -p /app/data

# Agent keys are mounted from the host at runtime (never baked into the image)
# See docker-compose.yml for the volume mounts

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD wget -qO- http://localhost:3000/health || exit 1

CMD ["node", "sage.js", "daemon"]
