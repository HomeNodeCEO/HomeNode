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

ENV PYTHONPATH=/app:/app/scraper
ENV PORT=8080
ENV RUN_DCAD_WORKER=true
EXPOSE 8080

# Keep the public API/health check and continuous scraper alive together on the
# existing Render web-service instance.
CMD ["python", "-m", "scraper.service_runner"]
