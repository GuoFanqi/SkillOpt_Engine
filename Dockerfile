# ─── Stage 1: Build Frontend ───
FROM node:20-alpine AS frontend-builder
WORKDIR /app/web
COPY web/package.json web/package-lock.json ./
RUN npm ci
COPY web/ ./
RUN npx vite build

# ─── Stage 2: Production Runtime ───
FROM node:20-slim

# Install Python 3 + pip for training scripts
RUN apt-get update && \
    apt-get install -y --no-install-recommends python3 python3-pip python3-venv && \
    rm -rf /var/lib/apt/lists/* && \
    ln -sf python3 /usr/bin/python

WORKDIR /app

# ─── Backend dependencies (include dev deps for tsx) ───
COPY web/server/package.json web/server/package-lock.json ./web/server/
RUN cd web/server && npm ci

# ─── Backend source ───
COPY web/server/src/ ./web/server/src/
COPY web/server/tsconfig.json ./web/server/

# ─── Frontend build output ───
COPY --from=frontend-builder /app/web/dist ./web/dist

# ─── Python training engine ───
COPY pyproject.toml requirements.txt ./
COPY skillopt/ ./skillopt/
COPY scripts/ ./scripts/
COPY configs/ ./configs/
COPY data/ ./data/

# Create Python virtualenv and install
RUN python3 -m venv /app/venv && \
    /app/venv/bin/pip install --no-cache-dir -r requirements.txt && \
    /app/venv/bin/pip install --no-cache-dir -e .

# ─── Runtime directories ───
RUN mkdir -p /app/web/outputs /app/web/uploads

# ─── Port ───
EXPOSE 3002

# ─── Health check ───
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD node -e "require('http').get('http://localhost:3002/api/auth/me', r => process.exit(r.statusCode === 401 ? 0 : 1))"

# ─── Start ───
ENV NODE_ENV=production
ENV VENV_PYTHON=/app/venv/bin/python3
CMD ["node", "--import", "tsx/esm", "web/server/src/index.ts"]
