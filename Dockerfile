FROM node:22-bookworm-slim

ENV NODE_ENV=production \
    PORT=8000 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1

RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 python3-pip \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY requirements.txt ./
RUN python3 -m pip install --break-system-packages -r requirements.txt

COPY . .

EXPOSE 8000

CMD ["npm", "start"]
