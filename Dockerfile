FROM ghcr.io/jeffreybergier/altivec-intelligence:latest

# The controller runs Pi; agent tools still run in the existing isolated worker.
RUN apt-get update && apt-get install -y --no-install-recommends docker.io python3-jsonschema \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts --no-audit --no-fund \
    && npx playwright-core install --with-deps chromium
COPY source ./source
COPY schemas ./schemas
COPY tests ./tests
COPY *.py tsconfig.json ./
ENTRYPOINT []
CMD ["node", "source/main.ts"]
