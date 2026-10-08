# ── build ────────────────────────────────────────────────────────────────────
FROM node:20-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm install
COPY . .

# NEXT_PUBLIC_* is inlined into the client bundle at BUILD time, so the Privy app
# id must be present here (passed as a build arg from docker-compose). The Privy
# SECRET is NOT needed to build — it's a runtime-only env for the API route.
ARG NEXT_PUBLIC_PRIVY_APP_ID
ENV NEXT_PUBLIC_PRIVY_APP_ID=$NEXT_PUBLIC_PRIVY_APP_ID
RUN npm run build

# ── run ──────────────────────────────────────────────────────────────────────
FROM node:20-alpine AS run
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3000
# Next "standalone" output: a minimal server bundling only traced deps.
COPY --from=build /app/.next/standalone ./
COPY --from=build /app/.next/static ./.next/static
COPY --from=build /app/public ./public
EXPOSE 3000
CMD ["node", "server.js"]
