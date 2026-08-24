# ---------------------------------------------------------------------------
# Build stage
# ---------------------------------------------------------------------------
FROM node:22-alpine AS builder

WORKDIR /app

# Manifests first, and the workspace manifest with them: `npm ci` reads every workspace
# package.json, and the root prebuild script builds shared-schemas before the API. Copying
# only these means the install layer is reused until a dependency actually changes.
COPY package.json package-lock.json ./
COPY packages/shared-schemas/package.json ./packages/shared-schemas/

RUN npm ci

# Source last, so editing it does not invalidate the install layer above.
COPY tsconfig.json ./
COPY packages ./packages
COPY src ./src

RUN npm run build

# ---------------------------------------------------------------------------
# Production stage
# ---------------------------------------------------------------------------
FROM node:22-alpine

WORKDIR /app

ENV NODE_ENV=production

COPY package.json package-lock.json ./
COPY packages/shared-schemas/package.json ./packages/shared-schemas/

# --ignore-scripts is required, not cosmetic: the root `prepare` script runs husky, which
# is a devDependency and therefore absent here. Without it the install fails with exit 127
# and the image never builds.
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

COPY --from=builder /app/dist ./dist

# The compiled code imports '@serapeum/shared-schemas', which Node resolves through the
# workspace symlink in node_modules to packages/shared-schemas/dist. `npm ci` creates the
# symlink but nothing fills the target, so without this the first import fails at runtime.
COPY --from=builder /app/packages/shared-schemas/dist ./packages/shared-schemas/dist

# The prompts are runtime data, not build output — `promptDir` reads them from disk on
# startup. Leaving them out is why the image could not serve a single request: it built
# (once the install was fixed) and then failed to load the router prompt.
COPY prompts ./prompts

RUN addgroup -g 1001 -S nodejs && \
  adduser -S nodejs -u 1001 && \
  chown -R nodejs:nodejs /app

USER nodejs

# Overridden by the PORT env var; EXPOSE is documentation, not a binding.
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=3s --start-period=15s --retries=3 \
  CMD node -e "require('http').get('http://localhost:' + (process.env.PORT || 3000) + '/health', (r) => {process.exit(r.statusCode === 200 ? 0 : 1)}).on('error', () => process.exit(1))"

# tsconfig has rootDir "." so the compiler emits dist/src/, not dist/. The old
# CMD pointed at dist/index.js, which only ever existed as a stale artifact in a
# developer's working tree — a clean build never produces it.
CMD ["node", "dist/src/index.js"]
