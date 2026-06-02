"""
Rotating reward watcher — two jobs:
1. scan_quarterly_announcements: fires mid-March/June/September/December
   — reads Chase/Discover newsrooms + BusinessWire for new category announcements
2. weekly_diff_check: runs every Monday
   — MD5-diffs each card's source page, re-extracts on change
"""
import os, hashlib, uuid, importlib.util
from pathlib import Path
from pydantic import BaseModel, Field
from pydantic_ai import Agent
import firecrawl
import aiosqlite

DB_PATH      = os.getenv("DATABASE_URL") or "milkr.db"
FIRECRAWL_KEY = os.getenv("FIRECRAWL_API_KEY", "")

# ─── Importlib workaround for server/pipeline/ vs root pipeline/ collision ─────
# rotating.py lives at server/pipeline/watchers/rotating.py
# root extractor is at pipeline/extractor.py (4 levels up from this file)
_extractor_path = Path(__file__).resolve().parent.parent.parent.parent / "pipeline" / "extractor.py"
_ext_spec = importlib.util.spec_from_file_location("root_extractor_watcher", _extractor_path)
_ext_mod  = importlib.util.module_from_spec(_ext_spec)
_ext_spec.loader.exec_module(_ext_mod)
extractor  = _ext_mod.extractor
upsert_card = _ext_mod.upsert_card

# ─── Quarterly card sources ───────────────────────────────────────────────────

ROTATING_SOURCES = {
    "chase-freedom-flex": {
        "newsroom": "https://media.chase.com/news",
        "search_terms": ["rotating categories", "5% cash back", "quarterly", "Freedom"],
    },
    "discover-it-cashback": {
        "newsroom": "https://www.discover.com/credit-cards/cashback-bonus/",
        "search_terms": ["5% cashback", "quarterly categories", "activate"],
    },
}

PRESS_RELEASE_SOURCES = [
    "https://businesswire.com/news/home/latest/",
    "https://prnewswire.com/news-releases/financial-services-latest-news/",
]

# ─── Override extraction schema ───────────────────────────────────────────────

class RotatingOverride(BaseModel):
    card_id: str
    category: str = Field(description="One of: DINING, GROCERIES, TRAVEL, GAS, ECOMMERCE, ENTERTAINMENT, STREAMING, DRUGSTORE, TRANSIT, OTHER")
    rate: float
    start_date: str = Field(description="YYYY-MM-DD")
    end_date: str = Field(description="YYYY-MM-DD")
    cap_dollars: float | None = None
    requires_activation: bool = True
    is_new_announcement: bool = Field(description="True only if this is a new quarter not already in the DB")
    confidence: float = Field(ge=0.0, le=1.0)

override_agent = Agent(
    'anthropic:claude-haiku-4-5',
    output_type=RotatingOverride,
    system_prompt="""You extract rotating credit card reward announcements.
Given page content, find any new quarterly bonus category announcement.
Return the structured data for that announcement.
If no announcement is found, set is_new_announcement: false and use placeholder values.
Dates should be YYYY-MM-DD. Quarters: Q1=Jan-Mar, Q2=Apr-Jun, Q3=Jul-Sep, Q4=Oct-Dec."""
)

# ─── Quarterly scanner ────────────────────────────────────────────────────────

async def scan_quarterly_announcements():
    print("[Rotating watcher] Scanning quarterly announcements...")
    fc = firecrawl.FirecrawlApp(api_key=FIRECRAWL_KEY)

    async with aiosqlite.connect(DB_PATH) as db:
        for card_id, config in ROTATING_SOURCES.items():
            try:
                page = fc.scrape_url(config["newsroom"], formats=["markdown"])
                content = (getattr(page, "markdown", None) or "") [:6000]

                # Only process if keywords are present
                if not any(term.lower() in content.lower() for term in config["search_terms"]):
                    print(f"  [SKIP] {card_id}: no keywords found")
                    continue

                result = await override_agent.run(
                    f"Card: {card_id}\nPage content:\n{content}"
                )
                override = result.output

                if not override.is_new_announcement:
                    continue

                # Check if this override already exists
                rows = await db.execute_fetchall(
                    "SELECT id FROM card_reward_overrides WHERE card_id=? AND category=? AND start_date=?",
                    (card_id, override.category, override.start_date),
                )
                if rows:
                    continue

                await db.execute("""
                    INSERT INTO card_reward_overrides
                    (id, card_id, category, rate, cap_dollars, start_date, end_date,
                     requires_activation, source_url, confidence)
                    VALUES (?,?,?,?,?,?,?,?,?,?)
                """, (
                    str(uuid.uuid4()), card_id, override.category, override.rate,
                    override.cap_dollars, override.start_date, override.end_date,
                    int(override.requires_activation), config["newsroom"], override.confidence,
                ))
                await db.commit()
                print(f"  [NEW] {card_id}: {override.category} @ {override.rate}x "
                      f"{override.start_date}–{override.end_date}")

            except Exception as e:
                print(f"  [ERROR] {card_id}: {e}")

    print("[Rotating watcher] Quarterly scan complete.")

# ─── Weekly diff check ────────────────────────────────────────────────────────

async def weekly_diff_check():
    """Re-scrape all cards with a source_url. Re-extract if content changed."""
    print("[Rotating watcher] Weekly diff check...")
    fc = firecrawl.FirecrawlApp(api_key=FIRECRAWL_KEY)

    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        cards = await db.execute_fetchall(
            "SELECT id, name, source_url, content_hash FROM cards WHERE source_url IS NOT NULL"
        )

        for card in cards:
            try:
                page    = fc.scrape_url(card["source_url"], formats=["markdown"])
                content = getattr(page, "markdown", None) or ""
                fresh_hash = hashlib.md5(content.encode()).hexdigest()

                if fresh_hash == card["content_hash"]:
                    continue  # No change

                print(f"  [CHANGED] {card['name']} — re-extracting...")
                result = await extractor.run(f"Extract card data:\n\n{content[:8000]}")
                await upsert_card(db, result.output, card["source_url"], fresh_hash)

            except Exception as e:
                print(f"  [ERROR] {card['name']}: {e}")

    print("[Rotating watcher] Diff check complete.")
