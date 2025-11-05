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

ENV PYTHONPATH=/app
ENV PORT=8080
EXPOSE 8080

# Start FastAPI
CMD ["python", "-m", "uvicorn", "scraper.api.main:app", "--host", "0.0.0.0", "--port", "8080"]
