# Use Node LTS
FROM node:20-alpine AS builder

# Set working directory
WORKDIR /app

# Install dependencies
COPY package*.json ./
RUN npm install

# Copy project sources and generate Prisma client
COPY . .
RUN npx prisma generate

# Build app
RUN npm run build

# Keep only production dependencies
RUN npm prune --production

FROM node:20-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production

# ---------------------------------------------------------------------------
# #498 — runtime-stage hardening. Only this stage is modified by this change;
# the builder stage above is owned by a separate PR (#516) so the two do not
# conflict. See docs/CONTAINER_IMAGE.md for the full runtime contract.
# ---------------------------------------------------------------------------

# Dedicated service account. A named user/group (rather than a bare numeric
# UID) is used deliberately: it gives the account a real passwd entry, a
# nologin shell, and an ownership bit that survives `docker exec` debugging.
# UID/GID 1001 is chosen because it is in the unprivileged range and does not
# collide with the `node` account baked into the base image.
RUN addgroup -S -g 1001 truthbounty \
 && adduser -S -u 1001 -G truthbounty -h /app -s /sbin/nologin truthbounty

# Only runtime artifacts cross the stage boundary: production dependencies,
# the compiled bundle, and the generated Prisma client. No source, no config,
# no test fixtures, no .env — .dockerignore guarantees none of those are even
# present in the build context.
COPY package*.json ./
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/src/generated ./src/generated

# Hand the two writable-capable artifact trees to the service account. Applied
# as a targeted RUN rather than `COPY --chown` so the stage stays mergeable
# with the parallel builder-stage change and so the COPY lines remain exactly
# as they were.
RUN chown -R truthbounty:truthbounty /app/dist /app/src/generated

# Drop root. Everything after this point runs unprivileged, including anything
# a future layer might execute.
USER truthbounty

# Expose port
EXPOSE 3000

# Liveness probe against the route the application actually serves:
# `HealthController` is `@Controller('health')` + `@Public()` with
# `@Get('live')` (src/health/health.controller.ts), and no global prefix is set
# in src/main.ts — so the real path is GET /health/live. It is unauthenticated,
# so no credential is baked into the image. Implemented with the interpreter
# already present in the image rather than a wget/curl dependency.
# Deliberately NOT /health/ready: that endpoint fails closed when Postgres,
# the job queue, or the indexer is down, which would make Docker kill a
# container that is alive but correctly refusing traffic.
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD node -e "require('http').get({host:'127.0.0.1',port:process.env.PORT||3000,path:'/health/live',timeout:4000},r=>{process.exit(r.statusCode===200?0:1)}).on('error',()=>process.exit(1))"

# Start app
CMD ["npm", "run", "start:prod"]
