# CashCow

> AI-powered smart wallet — tells you the best way to pay at any checkout.

Built at Cal Hacks 12.0. Rebuilt with a clean stack.

## Structure

```
cashcow/
├── extension/     # Chrome extension — WXT + React + TypeScript
├── server/        # FastAPI backend — Claude classification + card data API
└── pipeline/      # Offline card catalog builder — Firecrawl + Claude + SQLite
```

## Quick start

```bash
# 1. Copy env files and fill in your keys
cp extension/.env.example extension/.env
cp server/.env.example server/.env

# 2. Extension
cd extension && npm install && npm run dev

# 3. Server
cd server && pip install -r requirements.txt && uvicorn main:app --reload

# 4. Pipeline (one-time catalog build)
cd pipeline && python build_catalog.py
```

## Tech stack

| Layer | Tools |
|---|---|
| Extension | WXT, React, TypeScript, Tailwind v4 |
| Storage | WXT storage (chrome.storage) + IndexedDB via idb |
| Backend | FastAPI, Python 3.12, Anthropic SDK, PydanticAI |
| Scraping | Firecrawl |
| Database | SQLite (dev) → PostgreSQL on Railway (prod) |
| Deployment | Railway (server) + Chrome Web Store (extension) |
| Card import | Plaid Liabilities API (sandbox) |
| Virtual cards | Lithic API (sandbox) |
