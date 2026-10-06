# syntax=docker/dockerfile:1

FROM node:22-alpine AS base
WORKDIR /app

# Prompts15 Phase 10 — NODE_ENV is deliberately NOT set on the shared base.
#
# Setting NODE_ENV=production here made `npm ci` omit devDependencies, so:
#   * `prepare: husky` could not resolve its binary  -> `npm ci` exited 127
#   * `typescript` was absent                        -> `npm run build` impossible
# The image therefore could not be built at all. Only the runtime stage sets
# NODE_ENV=production, which is the only place it affects behaviour.
ENV NODE_ENV=development

# --- Dependencies ---------------------------------------------------------
FROM base AS deps
COPY package.json package-lock.json ./
# --ignore-scripts: the only lifecycle script is `prepare: husky`, a local git
# hook installer that is meaningless (and failing) inside a build context that
# has no .git. Installing it as a side effect of `npm ci` breaks the build.
RUN npm ci --ignore-scripts

# --- Build -----------------------------------------------------------------
FROM base AS build
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build
# Drop build-only tooling (typescript, eslint, pino-pretty, ...) from the tree
# that ships. Keep NODE_ENV out of this step so prune actually removes them.
RUN npm prune --omit=dev

# --- Runtime ---------------------------------------------------------------
FROM base AS runtime
ENV NODE_ENV=production
ENV PORT=3000
ENV HOST=0.0.0.0

COPY --from=build /app/dist ./dist
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./
COPY --from=build /app/.env.example ./.env.example

# Runtime directories consumed by the AI ecosystem layers
RUN mkdir -p /app/logs /app/memory /app/knowledge

EXPOSE 3000
USER node

# Prompts15 Phase 8/10 — container health probe.
#
# Deliberately depends on `node` only: the alpine runtime image has no curl or
# wget, and adding a package purely for health checks would widen the attack
# surface. The probe uses the readiness endpoint so a container whose
# dependencies are degraded is reported unhealthy rather than "up but broken".
#
# The port is read from the same env var the server binds, so overriding PORT
# (as Render does) keeps the probe correct without rebuilding the image.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/readyz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/index.js"]
