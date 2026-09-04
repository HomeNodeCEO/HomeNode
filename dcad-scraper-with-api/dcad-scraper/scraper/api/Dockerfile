FROM python:3.11-slim

RUN apt-get update && apt-get install -y \
    libnss3 libatk-bridge2.0-0 libdrm2 libxkbcommon0 libgbm1 libasound2 libx11-xcb1 \
    libxcomposite1 libxrandr2 libxi6 libxtst6 libatk1.0-0 libcups2 libxdamage1 \
    libglib2.0-0 libgtk-3-0 wget gnupg ca-certificates \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Build context is ./scraper, so requirements.txt is at the root of context
COPY requirements.txt /app/requirements.txt
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
RUN mkdir -p /ms-playwright \
    && pip install --no-cache-dir -r requirements.txt \
    && python -m playwright install chromium \
    && groupadd --system homenode \
    && useradd --system --gid homenode --home-dir /home/homenode --create-home --shell /usr/sbin/nologin homenode \
    && chmod -R a+rX /ms-playwright

# Copy API code and the shared dcad package from the same context
COPY ./api /app/api
COPY ./dcad /app/dcad

ENV PYTHONDONTWRITEBYTECODE=1
USER homenode
CMD ["uvicorn", "api.main:app", "--host", "0.0.0.0", "--port", "8000"]

