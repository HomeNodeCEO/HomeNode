# DCAD Scraper (Postgres + Playwright + FastAPI)

## Quick start
1) Copy env:
```
cp scraper/config.example.env scraper/.env
```
2) Build & run DB + one-shot scrape:
```
docker compose up --build
```
3) Start API:
```
docker compose up --build api
# http://localhost:8000/healthz
# http://localhost:8000/lookup?account=26272500060150000
```
4) Batch:
```
docker compose run --rm scraper python batch.py /app/accounts.csv
docker compose run --rm scraper python batch.py 2627...,6021...,0000...
```
