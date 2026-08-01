# Debian slim, not Alpine. transformers.js pulls onnxruntime-node, whose
# prebuilt native bindings are glibc only. On musl it either fails to install
# or falls back to a much slower path.
FROM node:22-slim AS base
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH
RUN corepack enable

FROM base AS deps
WORKDIR /app
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/api/package.json apps/api/
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile --filter @sadhak/api...

FROM base AS runtime
WORKDIR /app
ENV NODE_ENV=production
# The embedding model downloads on first use. Mount /models as a volume or the
# container re-downloads roughly 130MB on every restart.
# MODEL_CACHE_DIR is the one src/embed.ts reads. HF_HOME and TRANSFORMERS_CACHE
# are the Python transformers variables and are ignored by transformers.js —
# they were the only thing set here, so the cache defaulted into node_modules,
# which this image's non-root user cannot write. Kept only for any tooling that
# still looks for them.
ENV MODEL_CACHE_DIR=/models HF_HOME=/models TRANSFORMERS_CACHE=/models

COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/packages/shared/node_modules ./packages/shared/node_modules
COPY --from=deps /app/apps/api/node_modules ./apps/api/node_modules
COPY pnpm-workspace.yaml package.json tsconfig.base.json ./
COPY packages/shared ./packages/shared
COPY apps/api ./apps/api
COPY db ./db

RUN mkdir -p /models && chown -R node:node /models
USER node
EXPOSE 3001
CMD ["pnpm", "--filter", "@sadhak/api", "start"]

# Liveness, not readiness: a database blip must not get this container killed,
# because restarting containers is exactly what does not help a database under
# load. node:22-slim ships no curl, so the probe is node itself.
HEALTHCHECK --interval=15s --timeout=5s --start-period=40s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT??3001)+'/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
