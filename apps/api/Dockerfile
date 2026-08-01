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
    pnpm install --frozen-lockfile --filter @ariadne/api...

FROM base AS runtime
WORKDIR /app
ENV NODE_ENV=production
# The embedding model downloads on first use. Mount /models as a volume or the
# container re-downloads roughly 130MB on every restart.
ENV HF_HOME=/models TRANSFORMERS_CACHE=/models

COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/packages/shared/node_modules ./packages/shared/node_modules
COPY --from=deps /app/apps/api/node_modules ./apps/api/node_modules
COPY pnpm-workspace.yaml package.json ./
COPY packages/shared ./packages/shared
COPY apps/api ./apps/api

RUN mkdir -p /models && chown -R node:node /models
USER node
EXPOSE 3001
CMD ["pnpm", "--filter", "@ariadne/api", "start"]
