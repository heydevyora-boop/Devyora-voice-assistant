# ── build ────────────────────────────────────────────────────────────
FROM node:22-alpine AS build
WORKDIR /app

# Install with the lockfile so the image matches what was tested.
COPY package.json package-lock.json ./
RUN npm ci

# The Prisma client is generated code; it has to exist before the compile.
COPY prisma ./prisma
RUN npx prisma generate

COPY tsconfig*.json nest-cli.json ./
COPY src ./src
RUN npm run build

# Drop dev dependencies from the tree that gets copied forward.
RUN npm prune --omit=dev

# ── runtime ──────────────────────────────────────────────────────────
FROM node:22-alpine AS runtime
WORKDIR /app

ENV NODE_ENV=production
# Tini reaps zombies and forwards signals, so Nest's shutdown hooks actually
# run when the orchestrator sends SIGTERM.
RUN apk add --no-cache tini

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/prisma ./prisma
COPY package.json ./

# Never run as root.
USER node

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=3s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/health/live').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/sbin/tini", "--"]
# Migrations are applied by a separate pre-deploy step, never at boot:
# two replicas starting at once must not race on the same schema.
CMD ["node", "dist/main.js"]
