# Milkr

> AI-powered smart wallet Chrome extension — tells you the best card to use at every checkout.

Built at Cal Hacks 12.0 as "CashCow", rebuilt as Milkr.

## What it does

1. Detects checkout pages automatically via multi-signal DOM analysis
2. Classifies the merchant using Claude Haiku (MCC-aware, not just URL → category)
3. Ranks every card in your wallet by expected dollar value back
4. Surfaces the winner with rationale, activation warnings, BNPL (Buy Now, Pay Later) options, and gift card stacking tips
5. **Import from bank** — connects via Plaid, fetches your credit cards from the liabilities API, and fuzzy-matches them to the catalog so setup takes seconds
6. **For You tab** — spend-aware card recommendations based on your actual checkout history

## Why it's different

| | Milkr | Kudos / MaxRewards |
|---|---|---|
| Card types | Credit + debit + BNPL | Credit cards only |
| Login required | No | Yes |
| MCC classification | ✓ (Walmart ≠ grocery) | URL-based only |
| Card data pipeline | Own-built (Firecrawl + Claude) | Third-party API |
| Rotating rewards | Auto-detected quarterly | Manual |
| Privacy | Only merchant name leaves browser | Account sync required |

## Architecture

```
extension/
├── src/entrypoints/
│   ├── content.ts          # Checkout detection, BNPL DOM scan, MutationObserver (SPA-safe)
│   ├── background.ts       # Service worker — badge management, session storage
│   └── popup/              # React popup UI
│       ├── App.tsx          # State machine: loading → wallet-setup | plaid-import | recommendation | error
│       ├── RecommendationView.tsx
│       ├── WalletSetup.tsx
│       └── api.ts           # Typed fetch wrappers for all server endpoints
├── src/components/
│   ├── PlaidImport.tsx     # Bank import confirm UI — fuzzy match results, checkbox select
│   ├── CardRecommendations.tsx  # "For You" tab — spend-based card suggestions
│   └── CardSearch.tsx      # Freeform card search + AI enrich fallback
├── src/lib/
│   ├── rewards/engine.ts   # Reward resolver — MCC exclusions, cap splits, blended rates, FTF
│   └── storage/index.ts    # WXT storage (wallet) + IndexedDB (history, spend tracking)
└── src/types/index.ts      # Shared types

server/
├── routes/
│   ├── classify.py         # POST /classify/merchant — Claude Haiku via PydanticAI
│   ├── cards.py            # GET /cards/ + search + enrich — catalog + overrides from SQLite
│   ├── plaid.py            # Plaid link-token, server-hosted Link page, exchange, liabilities, fuzzy match
│   └── admin.py            # POST /admin/run/{job} — manual scheduler trigger
├── pipeline/watchers/
│   └── rotating.py         # APScheduler — weekly diff check + quarterly reward scanner
└── db/database.py          # SQLite schema: cards, card_reward_overrides, mcc_map

pipeline/
└── extractor.py            # Firecrawl + Claude Sonnet — scrapes issuer pages → structured card data
```

## Edge cases handled

- **Superstore exclusions** — Amex Gold earns 4x at grocery stores, but not at Target or Walmart (which are classified as discount stores, not groceries). Milkr knows the difference and won't show the wrong rate.
- **Spending cap splits** — Some cards cap bonus rates at a yearly limit (e.g. Amex Gold: 4x groceries up to $25K/yr). If you're near the cap, Milkr calculates a blended rate across the bonus and base portions of your transaction.
- **Rotating category activation** — Cards like Chase Freedom and Discover It require you to manually activate bonus categories each quarter. Milkr shows a warning and links directly to the activation page.
- **Single-page app navigation** — Most checkout flows (Amazon, Shopify) don't trigger a full page reload. Milkr uses a `MutationObserver` to watch for DOM changes so it never misses a checkout.
- **Point value subjectivity** — Chase points are worth 1¢ as cash back, 1.5¢ through the travel portal, or 2¢+ via transfer partners. You set your preference at wallet setup so the ranking reflects what your points are actually worth to you.
- **Network acceptance** — Costco only accepts Visa. Milkr filters out incompatible cards before ranking so it never recommends a card that won't work.
- **Foreign transaction fees** — Cards with a 3% foreign transaction fee get that amount deducted from their expected value when you're on a non-US site.

## Tech stack

| Layer | Tools |
|---|---|
| Extension | WXT (MV3), React 18, TypeScript, Tailwind v4 |
| Storage | WXT storage (`chrome.storage`) + IndexedDB via `idb` |
| Backend | FastAPI, Python 3.12, PydanticAI, APScheduler |
| AI | Claude Haiku (classification) · Claude Sonnet (card extraction) |
| Scraping | Firecrawl |
| Database | SQLite (dev) → PostgreSQL on Railway (prod) |
| Deployment | Railway (server) · Chrome Web Store (extension) |
| Card import | Plaid Liabilities API (sandbox) |
| Virtual cards | Lithic API (sandbox, roadmap) |

## Quick start

```bash
# 1. Fill in API keys
cp server/.env.example server/.env   # add ANTHROPIC_API_KEY at minimum

# 2. Seed the card catalog
cd server
python -m venv venv && source venv/bin/activate
pip install -r requirements.txt
python build_catalog.py

# 3. Start the server
uvicorn main:app --reload

# 4. Build the extension (separate terminal)
cd extension
npm install
cp .env.example .env                 # VITE_API_URL=http://localhost:8000
npm run build

# 5. Load in Chrome
# chrome://extensions → Developer mode → Load unpacked → extension/.output/chrome-mv3
```