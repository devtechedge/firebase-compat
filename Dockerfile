# syntax=docker/dockerfile:1
FROM node:22-slim AS build
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml turbo.json tsconfig.base.json ./
COPY packages/server/package.json packages/server/
RUN pnpm install --frozen-lockfile --filter @firebase-compat/server...
COPY packages/server packages/server
RUN pnpm --filter @firebase-compat/server build \
 && pnpm --filter @firebase-compat/server deploy --prod /out

FROM node:22-slim
ENV NODE_ENV=production PORT=8787 DATA_FILE=/data/firebase-compat.sqlite FIREBASE_PROJECT=demo-project NODE_NO_WARNINGS=1
WORKDIR /app
COPY --from=build /out /app
RUN mkdir -p /data && chown node:node /data
VOLUME /data
EXPOSE 8787
HEALTHCHECK --interval=10s --timeout=3s CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
USER node
CMD ["node", "dist/cli.js"]
