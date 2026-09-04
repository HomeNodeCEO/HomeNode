FROM python:3.11-slim
RUN apt-get update && apt-get install -y     libnss3 libatk-bridge2.0-0 libdrm2 libxkbcommon0 libgbm1 libasound2 libx11-xcb1     libxcomposite1 libxrandr2 libxi6 libxtst6 libatk1.0-0 libcups2 libxdamage1     libglib2.0-0 libgtk-3-0 wget gnupg ca-certificates  && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY requirements.txt /app/requirements.txt
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
RUN mkdir -p /ms-playwright \
    && pip install --no-cache-dir -r requirements.txt \
    && python -m playwright install chromium \
    && groupadd --system homenode \
    && useradd --system --gid homenode --home-dir /home/homenode --create-home --shell /usr/sbin/nologin homenode \
    && chmod -R a+rX /ms-playwright
COPY . /app
ENV PYTHONUNBUFFERED=1
ENV PYTHONDONTWRITEBYTECODE=1
USER homenode
CMD ["python", "run_once.py"]
