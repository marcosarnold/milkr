"""
Card catalog extractor.
Firecrawl fetches + cleans each issuer page → Claude Sonnet extracts structured data.
PydanticAI enforces the schema with automatic retry on parse failure.
"""
import os, asyncio, hashlib, json
from pydantic import BaseModel, Field
from pydantic_ai import Agent
import firecrawl
import aiosqlite

FIRECRAWL_KEY = os.getenv("FIRECRAWL_API_KEY", "")
DB_PATH = os.getenv("DATABASE_URL") or "milkr.db"

# ─── Issuer discovery URLs ────────────────────────────────────────────────────
# These are the listing pages — extractor crawls links from each

ISSUER_LISTING_PAGES = [
    "https://creditcards.chase.com",
    "https://www.americanexpress.com/us/credit-cards/",
    "https://www.capitalone.com/credit-cards/",
    "https://www.citi.com/credit-cards/",
    "https://www.bankofamerica.com/credit-cards/",
    "https://www.discover.com/credit-cards/",
    "https://www.wellsfargo.com/credit-cards/",
    "https://www.usbank.com/credit-cards.html",
]

# ─── Output schema ────────────────────────────────────────────────────────────

class CardExtraction(BaseModel):
    name: str
    issuer: str
    network: str = Field(description="visa, mastercard, amex, or discover")
    card_type: str = Field(default="credit", description="credit, debit, or prepaid")
    annual_fee: float = Field(default=0)
    reward_type: str = Field(description="cashback, points, miles, or flex")
    point_value: float = Field(default=0.01, description="cents per point, e.g. 0.01 for 1cpp cash")
    rate_dining: float = Field(default=1.0)
    rate_groceries: float = Field(default=1.0)
    rate_travel: float = Field(default=1.0)
    rate_gas: float = Field(default=1.0)
    rate_ecommerce: float = Field(default=1.0)
    rate_entertainment: float = Field(default=1.0)
    rate_streaming: float = Field(default=1.0)
    rate_drugstore: float = Field(default=1.0)
    rate_transit: float = Field(default=1.0)
    rate_other: float = Field(default=1.0)
    has_rewards: bool = Field(default=True)
    rotating_categories: bool = Field(default=False)
    foreign_tx_fee: bool = Field(default=True)
    not_accepted_at: list[str] = Field(default_factory=list, description="Domain list, e.g. ['costco.com'] for Amex")
    category_exclusions: list[dict] = Field(default_factory=list, description="[{category, excludedMerchants:[]}]")
    annual_caps: dict = Field(default_factory=dict, description="{CATEGORY: dollar_cap}")

# ─── PydanticAI agent — Claude Sonnet for nuanced reward language ─────────────

extractor = Agent(
    'anthropic:claude-sonnet-4-6',
    output_type=CardExtraction,
    system_prompt="""You extract credit card reward data from marketing page content.
    
Rules for rate extraction:
- "3X points" or "3 points per $1" or "3% cash back" → rate: 3.0
- "Earn up to 6%" → use the maximum rate but note cap
- Base/catch-all rate is always rate_other
- If a category isn't mentioned, default to rate_other (usually 1.0)
- For rotating category cards (Chase Freedom, Discover It): rotating_categories: true, set rates to base rate

Rules for exclusions:
- Amex "US supermarkets" excludes: target.com, walmart.com, costco.com
- Chase "grocery stores" excludes: target.com, walmart.com
- Costco cards: not_accepted_at Amex cards → not_accepted_at: ["costco.com"]

Rules for network:
- American Express → network: "amex"
- Discover → network: "discover"

Return the numeric rate ONLY — not "3x" but 3.0.
Return valid JSON matching the schema exactly. No extra text."""
)

# ─── Extraction pipeline ──────────────────────────────────────────────────────

def make_card_id(name: str, issuer: str) -> str:
    slug = f"{issuer}-{name}".lower().replace(" ", "-").replace("®", "").replace("™", "")
    return "".join(c for c in slug if c.isalnum() or c == "-")

async def extract_card_from_url(url: str, fc: firecrawl.FirecrawlApp) -> CardExtraction | None:
    try:
        page = fc.scrape_url(url, params={"formats": ["markdown"]})
        content = page.get("markdown", "")[:8000]  # truncate to avoid token waste
        if not content:
            return None
        result = await extractor.run(f"Extract card data from this page:\n\n{content}")
        return result.output
    except Exception as e:
        print(f"  [SKIP] {url}: {e}")
        return None

async def upsert_card(db: aiosqlite.Connection, card: CardExtraction, url: str, content_hash: str):
    card_id = make_card_id(card.name, card.issuer)
    await db.execute("""
        INSERT INTO cards (
            id, name, issuer, network, card_type, annual_fee, reward_type, point_value,
            rate_dining, rate_groceries, rate_travel, rate_gas, rate_ecommerce,
            rate_entertainment, rate_streaming, rate_drugstore, rate_transit, rate_other,
            has_rewards, rotating_categories, foreign_tx_fee,
            not_accepted_at, category_exclusions, annual_caps,
            source_url, content_hash, scraped_at
        ) VALUES (
            ?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,CURRENT_TIMESTAMP
        )
        ON CONFLICT(id) DO UPDATE SET
            rate_dining=excluded.rate_dining, rate_groceries=excluded.rate_groceries,
            rate_travel=excluded.rate_travel, rate_gas=excluded.rate_gas,
            rate_ecommerce=excluded.rate_ecommerce, rate_entertainment=excluded.rate_entertainment,
            rate_streaming=excluded.rate_streaming, rate_drugstore=excluded.rate_drugstore,
            rate_transit=excluded.rate_transit, rate_other=excluded.rate_other,
            annual_fee=excluded.annual_fee, foreign_tx_fee=excluded.foreign_tx_fee,
            not_accepted_at=excluded.not_accepted_at,
            category_exclusions=excluded.category_exclusions,
            annual_caps=excluded.annual_caps,
            content_hash=excluded.content_hash,
            scraped_at=CURRENT_TIMESTAMP
    """, (
        card_id, card.name, card.issuer, card.network, card.card_type,
        card.annual_fee, card.reward_type, card.point_value,
        card.rate_dining, card.rate_groceries, card.rate_travel, card.rate_gas,
        card.rate_ecommerce, card.rate_entertainment, card.rate_streaming,
        card.rate_drugstore, card.rate_transit, card.rate_other,
        int(card.has_rewards), int(card.rotating_categories), int(card.foreign_tx_fee),
        json.dumps(card.not_accepted_at), json.dumps(card.category_exclusions),
        json.dumps(card.annual_caps), url, content_hash,
    ))
    await db.commit()
    print(f"  [OK] {card.issuer} — {card.name}")

async def build_catalog(seed_urls: list[str] | None = None):
    """Run full catalog build. Pass seed_urls to override defaults."""
    fc = firecrawl.FirecrawlApp(api_key=FIRECRAWL_KEY)
    urls = seed_urls or ISSUER_LISTING_PAGES

    async with aiosqlite.connect(DB_PATH) as db:
        # Ensure tables exist
        from db.database import init_db
        await init_db()

        for listing_url in urls:
            print(f"\nCrawling: {listing_url}")
            try:
                # Discover card detail page links from the listing page
                crawl = fc.crawl_url(
                    listing_url,
                    params={"limit": 30, "scrapeOptions": {"formats": ["links"]}},
                    poll_interval=5,
                )
                links = crawl.get("data", [])
                card_links = [
                    d["metadata"]["sourceURL"]
                    for d in links
                    if d.get("metadata", {}).get("sourceURL")
                    and any(
                        kw in d["metadata"]["sourceURL"].lower()
                        for kw in ["credit-card", "creditcard", "card/", "/cards/"]
                    )
                ]
                print(f"  Found {len(card_links)} card pages")

                for url in card_links[:20]:  # cap per issuer to control API usage
                    card = await extract_card_from_url(url, fc)
                    if card:
                        content_hash = hashlib.md5(url.encode()).hexdigest()
                        await upsert_card(db, card, url, content_hash)

            except Exception as e:
                print(f"  [ERROR] {listing_url}: {e}")

    print("\nCatalog build complete.")

if __name__ == "__main__":
    asyncio.run(build_catalog())
