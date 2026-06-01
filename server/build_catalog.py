#!/usr/bin/env python3
"""
Run this once to:
1. Create the SQLite database and tables
2. Seed a small set of well-known cards (no scraping needed)
3. Optionally kick off the full Firecrawl extraction

Usage:
  python build_catalog.py            # seed only (no API keys needed)
  python build_catalog.py --full     # seed + Firecrawl extraction
"""
import asyncio, sys, json, uuid
import aiosqlite
from dotenv import load_dotenv

load_dotenv()

sys.path.insert(0, ".")  # allow imports from server/

SEED_CARDS = [
    {
        "id": "chase-sapphire-preferred",
        "name": "Chase Sapphire Preferred",
        "issuer": "Chase",
        "network": "visa",
        "card_type": "credit",
        "annual_fee": 95,
        "reward_type": "points",
        "point_value": 0.0125,
        "rate_dining": 3.0,
        "rate_groceries": 1.0,
        "rate_travel": 2.0,
        "rate_gas": 1.0,
        "rate_ecommerce": 1.0,
        "rate_entertainment": 1.0,
        "rate_streaming": 1.0,
        "rate_drugstore": 1.0,
        "rate_transit": 1.0,
        "rate_other": 1.0,
        "has_rewards": 1, "rotating_categories": 0, "foreign_tx_fee": 0,
        "not_accepted_at": "[]",
        "category_exclusions": json.dumps([{"category":"GROCERIES","excludedMerchants":["walmart.com","target.com"]}]),
        "annual_caps": "{}",
    },
    {
        "id": "amex-gold",
        "name": "American Express Gold Card",
        "issuer": "American Express",
        "network": "amex",
        "card_type": "credit",
        "annual_fee": 325,
        "reward_type": "points",
        "point_value": 0.01,
        "rate_dining": 4.0,
        "rate_groceries": 4.0,
        "rate_travel": 3.0,
        "rate_gas": 1.0,
        "rate_ecommerce": 1.0,
        "rate_entertainment": 1.0,
        "rate_streaming": 1.0,
        "rate_drugstore": 1.0,
        "rate_transit": 1.0,
        "rate_other": 1.0,
        "has_rewards": 1, "rotating_categories": 0, "foreign_tx_fee": 0,
        "not_accepted_at": json.dumps(["costco.com"]),
        "category_exclusions": json.dumps([{"category":"GROCERIES","excludedMerchants":["walmart.com","target.com","costco.com"]}]),
        "annual_caps": json.dumps({"GROCERIES": 25000}),
    },
    {
        "id": "chase-freedom-flex",
        "name": "Chase Freedom Flex",
        "issuer": "Chase",
        "network": "mastercard",
        "card_type": "credit",
        "annual_fee": 0,
        "reward_type": "cashback",
        "point_value": 0.01,
        "rate_dining": 3.0,
        "rate_groceries": 1.0,
        "rate_travel": 5.0,
        "rate_gas": 1.0,
        "rate_ecommerce": 1.0,
        "rate_entertainment": 1.0,
        "rate_streaming": 1.0,
        "rate_drugstore": 3.0,
        "rate_transit": 1.0,
        "rate_other": 1.0,
        "has_rewards": 1, "rotating_categories": 1, "foreign_tx_fee": 1,
        "not_accepted_at": "[]",
        "category_exclusions": "[]",
        "annual_caps": "{}",
    },
    {
        "id": "discover-it-cashback",
        "name": "Discover it Cash Back",
        "issuer": "Discover",
        "network": "discover",
        "card_type": "credit",
        "annual_fee": 0,
        "reward_type": "cashback",
        "point_value": 0.01,
        "rate_dining": 1.0,
        "rate_groceries": 1.0,
        "rate_travel": 1.0,
        "rate_gas": 1.0,
        "rate_ecommerce": 1.0,
        "rate_entertainment": 1.0,
        "rate_streaming": 1.0,
        "rate_drugstore": 1.0,
        "rate_transit": 1.0,
        "rate_other": 1.0,
        "has_rewards": 1, "rotating_categories": 1, "foreign_tx_fee": 1,
        "not_accepted_at": "[]",
        "category_exclusions": "[]",
        "annual_caps": "{}",
    },
    {
        "id": "citi-double-cash",
        "name": "Citi Double Cash Card",
        "issuer": "Citi",
        "network": "mastercard",
        "card_type": "credit",
        "annual_fee": 0,
        "reward_type": "cashback",
        "point_value": 0.01,
        "rate_dining": 2.0,
        "rate_groceries": 2.0,
        "rate_travel": 2.0,
        "rate_gas": 2.0,
        "rate_ecommerce": 2.0,
        "rate_entertainment": 2.0,
        "rate_streaming": 2.0,
        "rate_drugstore": 2.0,
        "rate_transit": 2.0,
        "rate_other": 2.0,
        "has_rewards": 1, "rotating_categories": 0, "foreign_tx_fee": 1,
        "not_accepted_at": "[]",
        "category_exclusions": "[]",
        "annual_caps": "{}",
    },
    # Rewards debit card example
    {
        "id": "discover-cashback-debit",
        "name": "Discover Cashback Debit",
        "issuer": "Discover",
        "network": "discover",
        "card_type": "debit",
        "annual_fee": 0,
        "reward_type": "cashback",
        "point_value": 0.01,
        "rate_dining": 1.0,
        "rate_groceries": 1.0,
        "rate_travel": 1.0,
        "rate_gas": 1.0,
        "rate_ecommerce": 1.0,
        "rate_entertainment": 1.0,
        "rate_streaming": 1.0,
        "rate_drugstore": 1.0,
        "rate_transit": 1.0,
        "rate_other": 1.0,
        "has_rewards": 1, "rotating_categories": 0, "foreign_tx_fee": 0,
        "not_accepted_at": "[]",
        "category_exclusions": "[]",
        "annual_caps": json.dumps({"OTHER": 3000}),
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

async def seed():
    from db.database import init_db, DB_PATH
    await init_db()
    async with aiosqlite.connect(DB_PATH) as db:
        for card in SEED_CARDS:
            await db.execute(INSERT_CARD, card)
        await db.commit()
    print(f"Seeded {len(SEED_CARDS)} cards.")

async def main():
    await seed()
    if "--full" in sys.argv:
        print("\nRunning full Firecrawl extraction (this may take a few minutes)...")
        from pipeline.extractor import build_catalog
        await build_catalog()

if __name__ == "__main__":
    asyncio.run(main())
