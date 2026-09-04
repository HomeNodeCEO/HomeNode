FROM python:3.11-slim

# Helpful libs for HTML/XML parsing on slim images
RUN apt-get update && apt-get install -y --no-install-recommends \
    libxml2 libxslt1.1 && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy deps first for better caching
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copy the rest of your app
COPY . .

RUN groupadd --system homenode \
    && useradd --system --gid homenode --home-dir /home/homenode --create-home --shell /usr/sbin/nologin homenode \
    && mkdir -p /app/storage \
    && chown -R homenode:homenode /app/storage

ENV PYTHONPATH=/app:/app/scraper
ENV PYTHONDONTWRITEBYTECODE=1
ENV PORT=8080
ENV RUN_DCAD_WORKER=true
EXPOSE 8080

USER homenode

# Keep the public API/health check and continuous scraper alive together on the
# existing Render web-service instance.
CMD ["python", "-m", "scraper.service_runner"]
