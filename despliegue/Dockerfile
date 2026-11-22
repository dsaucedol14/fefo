# Imagen de la API con el cliente PWA compilado (ADR-001, ADR-008)
FROM node:22-alpine AS construccion
WORKDIR /app
COPY package.json package-lock.json ./
COPY servidor/package.json servidor/
COPY cliente/package.json cliente/
RUN npm ci
COPY servidor servidor
COPY cliente cliente
RUN npm run build -w cliente && npm run build -w servidor

FROM node:22-alpine
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
COPY servidor/package.json servidor/
COPY cliente/package.json cliente/
RUN npm ci --omit=dev -w servidor && npm cache clean --force
COPY --from=construccion /app/servidor/dist servidor/dist
COPY --from=construccion /app/cliente/dist cliente/dist
COPY bd bd
USER node
EXPOSE 3000
CMD ["node", "servidor/dist/index.js"]
