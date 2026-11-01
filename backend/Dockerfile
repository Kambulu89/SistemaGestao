# syntax=docker/dockerfile:1
# Imagens da API. Alvos: `dev` (código montado por volume, recarregamento) e `prod` (build compilado).
ARG NODE_VERSION=22.22.3

FROM node:${NODE_VERSION}-alpine AS base
WORKDIR /app

FROM base AS deps
COPY package.json package-lock.json ./
RUN npm ci

FROM deps AS dev
COPY . .
EXPOSE 3333
CMD ["node", "ace", "serve", "--hmr"]

FROM deps AS build
COPY . .
RUN node ace build

FROM base AS prod
ENV NODE_ENV=production
COPY --from=build /app/build ./
RUN npm ci --omit=dev
USER node
EXPOSE 3333
CMD ["node", "bin/server.js"]
