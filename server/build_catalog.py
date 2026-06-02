#!/usr/bin/env python3
"""
Run this once to:
1. Create the SQLite database and tables
2. Seed 21 real cards with accurate current reward rates
3. Optionally kick off the full Firecrawl extraction

Usage:
  python build_catalog.py            # seed only (no API keys needed)
  python build_catalog.py --full     # seed + Firecrawl extraction

Rate accuracy: verified June 2026.
Portal-only bonuses (5x Chase portal, 10x CapOne hotels) are excluded from
base rates — Milkr can't detect which booking platform you're on.
"""
import asyncio, sys, json, uuid
import aiosqlite
from dotenv import load_dotenv

load_dotenv()
sys.path.insert(0, ".")

# ─── Shared JSON snippets ─────────────────────────────────────────────────────
_NO_EXCLUSIONS    = "[]"
_NO_CAPS          = "{}"
_NO_BLOCKED       = "[]"
_AMEX_BLOCKED     = json.dumps(["costco.com"])          # Costco is Visa-only
_AMEX_GROC_EXCL   = json.dumps([{"category": "GROCERIES", "excludedMerchants": ["walmart.com", "target.com", "costco.com"]}])
_CHASE_GROC_EXCL  = json.dumps([{"category": "GROCERIES", "excludedMerchants": ["walmart.com", "target.com", "costco.com"]}])
_CITI_GROC_EXCL   = json.dumps([{"category": "GROCERIES", "excludedMerchants": ["walmart.com", "target.com"]}])

SEED_CARDS = [

    # ── Chase ──────────────────────────────────────────────────────────────────

    {
        "id": "chase-sapphire-preferred",
        "name": "Chase Sapphire Preferred",
        "issuer": "Chase", "network": "visa", "card_type": "credit",
        "annual_fee": 95, "reward_type": "points", "point_value": 0.0125,
        "rate_dining": 3.0, "rate_groceries": 3.0, "rate_travel": 2.0,
        "rate_gas": 1.0, "rate_ecommerce": 1.0, "rate_entertainment": 1.0,
        "rate_streaming": 3.0, "rate_drugstore": 1.0, "rate_transit": 1.0, "rate_other": 1.0,
        "has_rewards": 1, "rotating_categories": 0, "foreign_tx_fee": 0,
        "not_accepted_at": _NO_BLOCKED,
        "category_exclusions": _CHASE_GROC_EXCL, "annual_caps": _NO_CAPS,
    },
    {
        "id": "chase-sapphire-reserve",
        "name": "Chase Sapphire Reserve",
        "issuer": "Chase", "network": "visa", "card_type": "credit",
        "annual_fee": 550, "reward_type": "points", "point_value": 0.015,
        "rate_dining": 3.0, "rate_groceries": 1.0, "rate_travel": 3.0,
        "rate_gas": 1.0, "rate_ecommerce": 1.0, "rate_entertainment": 1.0,
        "rate_streaming": 1.0, "rate_drugstore": 1.0, "rate_transit": 3.0, "rate_other": 1.0,
        "has_rewards": 1, "rotating_categories": 0, "foreign_tx_fee": 0,
        "not_accepted_at": _NO_BLOCKED, "category_exclusions": _NO_EXCLUSIONS, "annual_caps": _NO_CAPS,
    },
    {
        # 3x dining + drugstore; flat 1.5x everywhere else
        "id": "chase-freedom-unlimited",
        "name": "Chase Freedom Unlimited",
        "issuer": "Chase", "network": "visa", "card_type": "credit",
        "annual_fee": 0, "reward_type": "cashback", "point_value": 0.01,
        "rate_dining": 3.0, "rate_groceries": 1.5, "rate_travel": 1.5,
        "rate_gas": 1.5, "rate_ecommerce": 1.5, "rate_entertainment": 1.5,
        "rate_streaming": 1.5, "rate_drugstore": 3.0, "rate_transit": 1.5, "rate_other": 1.5,
        "has_rewards": 1, "rotating_categories": 0, "foreign_tx_fee": 1,
        "not_accepted_at": _NO_BLOCKED, "category_exclusions": _NO_EXCLUSIONS, "annual_caps": _NO_CAPS,
    },
    {
        # 3x dining + drugstore; rotating 5x quarterly (seeded via overrides table)
        "id": "chase-freedom-flex",
        "name": "Chase Freedom Flex",
        "issuer": "Chase", "network": "mastercard", "card_type": "credit",
        "annual_fee": 0, "reward_type": "cashback", "point_value": 0.01,
        "rate_dining": 3.0, "rate_groceries": 1.0, "rate_travel": 1.0,
        "rate_gas": 1.0, "rate_ecommerce": 1.0, "rate_entertainment": 1.0,
        "rate_streaming": 1.0, "rate_drugstore": 3.0, "rate_transit": 1.0, "rate_other": 1.0,
        "has_rewards": 1, "rotating_categories": 1, "foreign_tx_fee": 1,
        "not_accepted_at": _NO_BLOCKED, "category_exclusions": _NO_EXCLUSIONS, "annual_caps": _NO_CAPS,
    },

    # ── American Express ────────────────────────────────────────────────────────

    {
        # 4x dining + US supermarkets ($25K/yr cap); 3x flights
        "id": "amex-gold",
        "name": "American Express Gold Card",
        "issuer": "American Express", "network": "amex", "card_type": "credit",
        "annual_fee": 325, "reward_type": "points", "point_value": 0.01,
        "rate_dining": 4.0, "rate_groceries": 4.0, "rate_travel": 3.0,
        "rate_gas": 1.0, "rate_ecommerce": 1.0, "rate_entertainment": 1.0,
        "rate_streaming": 1.0, "rate_drugstore": 1.0, "rate_transit": 1.0, "rate_other": 1.0,
        "has_rewards": 1, "rotating_categories": 0, "foreign_tx_fee": 0,
        "not_accepted_at": _AMEX_BLOCKED,
        "category_exclusions": _AMEX_GROC_EXCL,
        "annual_caps": json.dumps({"GROCERIES": 25000}),
    },
    {
        # 5x flights + Amex Travel hotels; best pure-travel earning card
        "id": "amex-platinum",
        "name": "American Express Platinum Card",
        "issuer": "American Express", "network": "amex", "card_type": "credit",
        "annual_fee": 695, "reward_type": "points", "point_value": 0.01,
        "rate_dining": 1.0, "rate_groceries": 1.0, "rate_travel": 5.0,
        "rate_gas": 1.0, "rate_ecommerce": 1.0, "rate_entertainment": 1.0,
        "rate_streaming": 1.0, "rate_drugstore": 1.0, "rate_transit": 1.0, "rate_other": 1.0,
        "has_rewards": 1, "rotating_categories": 0, "foreign_tx_fee": 0,
        "not_accepted_at": _AMEX_BLOCKED, "category_exclusions": _NO_EXCLUSIONS, "annual_caps": _NO_CAPS,
    },
    {
        # 6x US supermarkets ($6K/yr) + streaming; 3x transit + gas
        "id": "amex-blue-cash-preferred",
        "name": "Blue Cash Preferred Card",
        "issuer": "American Express", "network": "amex", "card_type": "credit",
        "annual_fee": 95, "reward_type": "cashback", "point_value": 0.01,
        "rate_dining": 1.0, "rate_groceries": 6.0, "rate_travel": 1.0,
        "rate_gas": 3.0, "rate_ecommerce": 1.0, "rate_entertainment": 1.0,
        "rate_streaming": 6.0, "rate_drugstore": 1.0, "rate_transit": 3.0, "rate_other": 1.0,
        "has_rewards": 1, "rotating_categories": 0, "foreign_tx_fee": 1,
        "not_accepted_at": _AMEX_BLOCKED,
        "category_exclusions": _AMEX_GROC_EXCL,
        "annual_caps": json.dumps({"GROCERIES": 6000}),
    },
    {
        # 3x US supermarkets ($6K/yr) + streaming + transit; no annual fee
        "id": "amex-blue-cash-everyday",
        "name": "Blue Cash Everyday Card",
        "issuer": "American Express", "network": "amex", "card_type": "credit",
        "annual_fee": 0, "reward_type": "cashback", "point_value": 0.01,
        "rate_dining": 1.0, "rate_groceries": 3.0, "rate_travel": 1.0,
        "rate_gas": 1.0, "rate_ecommerce": 1.0, "rate_entertainment": 1.0,
        "rate_streaming": 3.0, "rate_drugstore": 1.0, "rate_transit": 3.0, "rate_other": 1.0,
        "has_rewards": 1, "rotating_categories": 0, "foreign_tx_fee": 1,
        "not_accepted_at": _AMEX_BLOCKED,
        "category_exclusions": _AMEX_GROC_EXCL,
        "annual_caps": json.dumps({"GROCERIES": 6000}),
    },

    # ── Citi ────────────────────────────────────────────────────────────────────

    {
        # 2% on everything (1% purchase + 1% payment); solid flat-rate card
        "id": "citi-double-cash",
        "name": "Citi Double Cash Card",
        "issuer": "Citi", "network": "mastercard", "card_type": "credit",
        "annual_fee": 0, "reward_type": "cashback", "point_value": 0.01,
        "rate_dining": 2.0, "rate_groceries": 2.0, "rate_travel": 2.0,
        "rate_gas": 2.0, "rate_ecommerce": 2.0, "rate_entertainment": 2.0,
        "rate_streaming": 2.0, "rate_drugstore": 2.0, "rate_transit": 2.0, "rate_other": 2.0,
        "has_rewards": 1, "rotating_categories": 0, "foreign_tx_fee": 1,
        "not_accepted_at": _NO_BLOCKED, "category_exclusions": _NO_EXCLUSIONS, "annual_caps": _NO_CAPS,
    },
    {
        # 5x top eligible spend category up to $500/mo; 1x everywhere else
        "id": "citi-custom-cash",
        "name": "Citi Custom Cash Card",
        "issuer": "Citi", "network": "mastercard", "card_type": "credit",
        "annual_fee": 0, "reward_type": "cashback", "point_value": 0.01,
        "rate_dining": 1.0, "rate_groceries": 1.0, "rate_travel": 1.0,
        "rate_gas": 1.0, "rate_ecommerce": 1.0, "rate_entertainment": 1.0,
        "rate_streaming": 1.0, "rate_drugstore": 1.0, "rate_transit": 1.0, "rate_other": 1.0,
        # rotating_categories signals that active overrides drive the bonus
        "has_rewards": 1, "rotating_categories": 1, "foreign_tx_fee": 1,
        "not_accepted_at": _NO_BLOCKED, "category_exclusions": _NO_EXCLUSIONS, "annual_caps": _NO_CAPS,
    },

    # ── Capital One ─────────────────────────────────────────────────────────────

    {
        # Flat 2x miles everywhere; great catch-all travel card
        "id": "capital-one-venture",
        "name": "Capital One Venture Rewards",
        "issuer": "Capital One", "network": "visa", "card_type": "credit",
        "annual_fee": 95, "reward_type": "miles", "point_value": 0.01,
        "rate_dining": 2.0, "rate_groceries": 2.0, "rate_travel": 2.0,
        "rate_gas": 2.0, "rate_ecommerce": 2.0, "rate_entertainment": 2.0,
        "rate_streaming": 2.0, "rate_drugstore": 2.0, "rate_transit": 2.0, "rate_other": 2.0,
        "has_rewards": 1, "rotating_categories": 0, "foreign_tx_fee": 0,
        "not_accepted_at": _NO_BLOCKED, "category_exclusions": _NO_EXCLUSIONS, "annual_caps": _NO_CAPS,
    },
    {
        # Flat 1.5x everywhere; simplest no-fee travel card
        "id": "capital-one-quicksilver",
        "name": "Capital One Quicksilver",
        "issuer": "Capital One", "network": "visa", "card_type": "credit",
        "annual_fee": 0, "reward_type": "cashback", "point_value": 0.01,
        "rate_dining": 1.5, "rate_groceries": 1.5, "rate_travel": 1.5,
        "rate_gas": 1.5, "rate_ecommerce": 1.5, "rate_entertainment": 1.5,
        "rate_streaming": 1.5, "rate_drugstore": 1.5, "rate_transit": 1.5, "rate_other": 1.5,
        "has_rewards": 1, "rotating_categories": 0, "foreign_tx_fee": 0,
        "not_accepted_at": _NO_BLOCKED, "category_exclusions": _NO_EXCLUSIONS, "annual_caps": _NO_CAPS,
    },
    {
        # 3x dining + entertainment + streaming + groceries; best no-fee lifestyle card
        "id": "capital-one-savorone",
        "name": "Capital One SavorOne",
        "issuer": "Capital One", "network": "mastercard", "card_type": "credit",
        "annual_fee": 0, "reward_type": "cashback", "point_value": 0.01,
        "rate_dining": 3.0, "rate_groceries": 3.0, "rate_travel": 1.0,
        "rate_gas": 1.0, "rate_ecommerce": 1.0, "rate_entertainment": 3.0,
        "rate_streaming": 3.0, "rate_drugstore": 1.0, "rate_transit": 1.0, "rate_other": 1.0,
        "has_rewards": 1, "rotating_categories": 0, "foreign_tx_fee": 0,
        "not_accepted_at": _NO_BLOCKED,
        "category_exclusions": _CITI_GROC_EXCL,   # superstores excluded
        "annual_caps": _NO_CAPS,
    },

    # ── Discover ────────────────────────────────────────────────────────────────

    {
        # 1x base + rotating 5x quarterly (cap $1,500/quarter) — seeded via overrides
        "id": "discover-it-cashback",
        "name": "Discover it Cash Back",
        "issuer": "Discover", "network": "discover", "card_type": "credit",
        "annual_fee": 0, "reward_type": "cashback", "point_value": 0.01,
        "rate_dining": 1.0, "rate_groceries": 1.0, "rate_travel": 1.0,
        "rate_gas": 1.0, "rate_ecommerce": 1.0, "rate_entertainment": 1.0,
        "rate_streaming": 1.0, "rate_drugstore": 1.0, "rate_transit": 1.0, "rate_other": 1.0,
        "has_rewards": 1, "rotating_categories": 1, "foreign_tx_fee": 0,
        "not_accepted_at": _NO_BLOCKED, "category_exclusions": _NO_EXCLUSIONS, "annual_caps": _NO_CAPS,
    },

    # ── Bank of America ─────────────────────────────────────────────────────────

    {
        # 3x chosen category (default: ecommerce); 2x groceries + wholesale; 1x other
        "id": "bofa-cash-rewards",
        "name": "Bank of America Cash Rewards",
        "issuer": "Bank of America", "network": "visa", "card_type": "credit",
        "annual_fee": 0, "reward_type": "cashback", "point_value": 0.01,
        "rate_dining": 1.0, "rate_groceries": 2.0, "rate_travel": 1.0,
        "rate_gas": 1.0, "rate_ecommerce": 3.0, "rate_entertainment": 1.0,
        "rate_streaming": 1.0, "rate_drugstore": 1.0, "rate_transit": 1.0, "rate_other": 1.0,
        # rotating = true signals user needs to select their 3x category
        "has_rewards": 1, "rotating_categories": 1, "foreign_tx_fee": 1,
        "not_accepted_at": _NO_BLOCKED, "category_exclusions": _NO_EXCLUSIONS, "annual_caps": _NO_CAPS,
    },

    # ── Wells Fargo ─────────────────────────────────────────────────────────────

    {
        # Flat 2% unlimited cash rewards; no annual fee, no FTF
        "id": "wells-fargo-active-cash",
        "name": "Wells Fargo Active Cash Card",
        "issuer": "Wells Fargo", "network": "visa", "card_type": "credit",
        "annual_fee": 0, "reward_type": "cashback", "point_value": 0.01,
        "rate_dining": 2.0, "rate_groceries": 2.0, "rate_travel": 2.0,
        "rate_gas": 2.0, "rate_ecommerce": 2.0, "rate_entertainment": 2.0,
        "rate_streaming": 2.0, "rate_drugstore": 2.0, "rate_transit": 2.0, "rate_other": 2.0,
        "has_rewards": 1, "rotating_categories": 0, "foreign_tx_fee": 0,
        "not_accepted_at": _NO_BLOCKED, "category_exclusions": _NO_EXCLUSIONS, "annual_caps": _NO_CAPS,
    },

    # ── Apple ───────────────────────────────────────────────────────────────────

    {
        # 3% at select merchants; 2% via Apple Pay; modeled as flat 2x (Apple Pay rate)
        "id": "apple-card",
        "name": "Apple Card",
        "issuer": "Goldman Sachs", "network": "mastercard", "card_type": "credit",
        "annual_fee": 0, "reward_type": "cashback", "point_value": 0.01,
        "rate_dining": 2.0, "rate_groceries": 2.0, "rate_travel": 2.0,
        "rate_gas": 2.0, "rate_ecommerce": 2.0, "rate_entertainment": 2.0,
        "rate_streaming": 2.0, "rate_drugstore": 2.0, "rate_transit": 2.0, "rate_other": 2.0,
        "has_rewards": 1, "rotating_categories": 0, "foreign_tx_fee": 0,
        "not_accepted_at": _NO_BLOCKED, "category_exclusions": _NO_EXCLUSIONS, "annual_caps": _NO_CAPS,
    },

    # ── US Bank ─────────────────────────────────────────────────────────────────

    {
        # 5x two chosen categories; 2x one everyday category; 1x other
        "id": "us-bank-cash-plus",
        "name": "U.S. Bank Cash+",
        "issuer": "U.S. Bank", "network": "visa", "card_type": "credit",
        "annual_fee": 0, "reward_type": "cashback", "point_value": 0.01,
        "rate_dining": 2.0, "rate_groceries": 2.0, "rate_travel": 1.0,
        "rate_gas": 1.0, "rate_ecommerce": 1.0, "rate_entertainment": 1.0,
        "rate_streaming": 5.0, "rate_drugstore": 5.0, "rate_transit": 1.0, "rate_other": 1.0,
        # rotating = true — actual 5x categories require user selection each quarter
        "has_rewards": 1, "rotating_categories": 1, "foreign_tx_fee": 1,
        "not_accepted_at": _NO_BLOCKED, "category_exclusions": _NO_EXCLUSIONS, "annual_caps": _NO_CAPS,
    },

    # ── Robinhood ───────────────────────────────────────────────────────────────

    {
        # Flat 3% on everything — requires Robinhood Gold membership ($50/yr)
        "id": "robinhood-gold-card",
        "name": "Robinhood Gold Card",
        "issuer": "Robinhood", "network": "visa", "card_type": "credit",
        "annual_fee": 50, "reward_type": "cashback", "point_value": 0.01,
        "rate_dining": 3.0, "rate_groceries": 3.0, "rate_travel": 3.0,
        "rate_gas": 3.0, "rate_ecommerce": 3.0, "rate_entertainment": 3.0,
        "rate_streaming": 3.0, "rate_drugstore": 3.0, "rate_transit": 3.0, "rate_other": 3.0,
        "has_rewards": 1, "rotating_categories": 0, "foreign_tx_fee": 0,
        "not_accepted_at": _NO_BLOCKED, "category_exclusions": _NO_EXCLUSIONS, "annual_caps": _NO_CAPS,
    },

    # ── Debit cards ─────────────────────────────────────────────────────────────

    {
        # 1% cash back up to $3K/month in debit purchases
        "id": "discover-cashback-debit",
        "name": "Discover Cashback Debit",
        "issuer": "Discover", "network": "discover", "card_type": "debit",
        "annual_fee": 0, "reward_type": "cashback", "point_value": 0.01,
        "rate_dining": 1.0, "rate_groceries": 1.0, "rate_travel": 1.0,
        "rate_gas": 1.0, "rate_ecommerce": 1.0, "rate_entertainment": 1.0,
        "rate_streaming": 1.0, "rate_drugstore": 1.0, "rate_transit": 1.0, "rate_other": 1.0,
        "has_rewards": 1, "rotating_categories": 0, "foreign_tx_fee": 0,
        "not_accepted_at": _NO_BLOCKED, "category_exclusions": _NO_EXCLUSIONS,
        # $3K/month cap → approximate as $9K/quarter for our quarterly tracking period
        "annual_caps": json.dumps({"OTHER": 9000}),
    },
    {
        # Up to 15% at SoFi Perks merchants; 1% base everywhere else
        "id": "sofi-debit",
        "name": "SoFi Debit Mastercard",
        "issuer": "SoFi", "network": "mastercard", "card_type": "debit",
        "annual_fee": 0, "reward_type": "cashback", "point_value": 0.01,
        "rate_dining": 1.0, "rate_groceries": 1.0, "rate_travel": 1.0,
        "rate_gas": 1.0, "rate_ecommerce": 1.0, "rate_entertainment": 1.0,
        "rate_streaming": 1.0, "rate_drugstore": 1.0, "rate_transit": 1.0, "rate_other": 1.0,
        "has_rewards": 1, "rotating_categories": 0, "foreign_tx_fee": 0,
        "not_accepted_at": _NO_BLOCKED, "category_exclusions": _NO_EXCLUSIONS, "annual_caps": _NO_CAPS,
    },
]

INSERT_CARD = """
INSERT OR REPLACE INTO cards (
    id, name, issuer, network, card_type, annual_fee, reward_type, point_value,
    rate_dining, rate_groceries, rate_travel, rate_gas, rate_ecommerce,
    rate_entertainment, rate_streaming, rate_drugstore, rate_transit, rate_other,
    has_rewards, rotating_categories, foreign_tx_fee,
    not_accepted_at, category_exclusions, annual_caps
) VALUES (
    :id,:name,:issuer,:network,:card_type,:annual_fee,:reward_type,:point_value,
    :rate_dining,:rate_groceries,:rate_travel,:rate_gas,:rate_ecommerce,
    :rate_entertainment,:rate_streaming,:rate_drugstore,:rate_transit,:rate_other,
    :has_rewards,:rotating_categories,:foreign_tx_fee,
    :not_accepted_at,:category_exclusions,:annual_caps
)
"""

# ─── Q2 2026 rotating overrides ──────────────────────────────────────────────
# Chase Freedom Flex: Hotels + Streaming bonus quarter (Apr–Jun 2026)
# Discover It Cashback: Restaurants + Gas (Apr–Jun 2026)
# Source: issuer press releases / historical pattern for Q2.
SEED_OVERRIDES = [
    {
        "card_id": "chase-freedom-flex",
        "category": "TRAVEL",
        "rate": 5.0,
        "cap_dollars": 1500.0,
        "start_date": "2026-04-01",
        "end_date":   "2026-06-30",
        "requires_activation": 1,
        "source_url": "https://chasebonus.com",
        "confidence": 0.95,
    },
    {
        "card_id": "chase-freedom-flex",
        "category": "STREAMING",
        "rate": 5.0,
        "cap_dollars": 1500.0,   # shared $1,500 cap with the travel slot above
        "start_date": "2026-04-01",
        "end_date":   "2026-06-30",
        "requires_activation": 1,
        "source_url": "https://chasebonus.com",
        "confidence": 0.95,
    },
    {
        "card_id": "discover-it-cashback",
        "category": "DINING",
        "rate": 5.0,
        "cap_dollars": 1500.0,
        "start_date": "2026-04-01",
        "end_date":   "2026-06-30",
        "requires_activation": 1,
        "source_url": "https://www.discover.com/credit-cards/cashback-bonus/",
        "confidence": 0.95,
    },
    {
        "card_id": "discover-it-cashback",
        "category": "GAS",
        "rate": 5.0,
        "cap_dollars": 1500.0,
        "start_date": "2026-04-01",
        "end_date":   "2026-06-30",
        "requires_activation": 1,
        "source_url": "https://www.discover.com/credit-cards/cashback-bonus/",
        "confidence": 0.95,
    },
]

INSERT_OVERRIDE = """
INSERT OR IGNORE INTO card_reward_overrides
    (id, card_id, category, rate, cap_dollars, start_date, end_date,
     requires_activation, source_url, confidence)
VALUES
    (:id,:card_id,:category,:rate,:cap_dollars,:start_date,:end_date,
     :requires_activation,:source_url,:confidence)
"""

async def seed():
    from db.database import init_db, DB_PATH, migrate_db
    await init_db()
    await migrate_db()   # adds last_enriched_at column if missing
    async with aiosqlite.connect(DB_PATH) as db:
        for card in SEED_CARDS:
            await db.execute(INSERT_CARD, card)
        for override in SEED_OVERRIDES:
            await db.execute(INSERT_OVERRIDE, {**override, "id": str(uuid.uuid4())})
        await db.commit()
    print(f"Seeded {len(SEED_CARDS)} cards + {len(SEED_OVERRIDES)} Q2 2026 overrides.")

async def main():
    await seed()
    if "--full" in sys.argv:
        print("\nRunning full Firecrawl extraction (this may take a few minutes)...")
        from pipeline.extractor import build_catalog
        await build_catalog()

if __name__ == "__main__":
    asyncio.run(main())
