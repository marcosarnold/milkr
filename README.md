# Milkr

> AI-powered smart wallet Chrome extension — tells you the best card to use at every checkout.

Built at Cal Hacks 12.0 as "CashCow", rebuilt as Milkr.

## What it does

1. Detects checkout pages automatically via multi-signal DOM analysis
2. Classifies the merchant using Claude Haiku (MCC-aware, not just URL → category)
3. Ranks every card in your wallet by expected dollar value back
4. Surfaces the winner with rationale, activation warnings, BNPL options, and gift card stacking tips

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
│       ├── App.tsx          # State machine: loading → wallet-setup | recommendation | error
│       ├── RecommendationView.tsx
│       └── WalletSetup.tsx
├── src/lib/
│   ├── rewards/engine.ts   # Reward resolver — MCC exclusions, cap splits, blended rates, FTF
│   └── storage/index.ts    # WXT storage (wallet) + IndexedDB (history, spend tracking)
└── src/types/index.ts      # Shared types

server/
├── routes/
│   ├── classify.py         # POST /classify/merchant — Claude Haiku via PydanticAI
│   ├── cards.py            # GET /cards/ — serves catalog + overrides from SQLite
│   └── plaid.py            # Plaid link-token + exchange + liabilities
├── pipeline/watchers/
│   └── rotating.py         # APScheduler — weekly diff check + quarterly reward scanner
└── db/database.py          # SQLite schema: cards, card_reward_overrides, mcc_map

pipeline/
└── extractor.py            # Firecrawl + Claude Sonnet — scrapes issuer pages → structured card data
```

## Edge cases handled

- **Superstore exclusions** — Amex Gold earns 4x groceries but not at Target/Walmart (MCC 5310). Per-card `categoryExclusions[]` checked before ranking.
- **Spending cap splits** — Amex Gold caps groceries at $25K/yr. If $10 remains on a $50 order, blended rate = (10 × bonus + 40 × base) / 50.
- **Rotating category activation** — Chase Freedom and Discover It require manual activation. `requiresActivation` flag shown in UI with direct link.
- **SPA navigation** — `MutationObserver` debounced at 300ms, `lastHref` tracked inside `main()` to survive WXT's HMR.
- **Point value subjectivity** — Chase UR worth 1cpp cash, 1.5cpp portal, 2cpp+ transfers. User sets preference at setup; applied to EV calc.
- **Network acceptance** — Costco Visa-only enforced via `notAcceptedAt[]` per card.
- **Foreign transaction fees** — 3% FTF deducted from expected value on non-.com/.us domains.

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

## Roadmap

- [ ] Plaid auto-import (maps card names → catalog via rapidfuzz)
- [ ] Lithic virtual card routing (issue per-merchant card on the fly)
- [ ] Quarterly rotating reward auto-detection pipeline live
- [ ] Firefox support
