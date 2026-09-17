# Two stages: build with the dev dependencies, run without them.
#
# Next's standalone output is deliberately not used — `npm run setup` and the dev probes
# are part of what this image is for, and they need tsx and the real source tree. The
# image is bigger and the thing stays inspectable, which is the right trade for something
# a reviewer is going to poke at.

FROM node:20-slim AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:20-slim
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3000

COPY --from=build /app/package*.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/.next ./.next
COPY --from=build /app/public ./public
COPY --from=build /app/src ./src
COPY --from=build /app/scripts ./scripts
COPY --from=build /app/next.config.ts /app/tsconfig.json ./

EXPOSE 3000
CMD ["npm", "start"]
