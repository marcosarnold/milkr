import os, json, sys
from pathlib import Path
from datetime import datetime, timedelta
from fastapi import APIRouter, Query, HTTPException
from pydantic import BaseModel
import aiosqlite
from rapidfuzz import process as fuzz_process, fuzz

router = APIRouter()
DB_PATH = os.getenv("DATABASE_URL") or "milkr.db"

# ─── Existing routes ──────────────────────────────────────────────────────────

@router.get("/")
async def list_cards(issuer: str | None = Query(None)):
    """Return all cards in the catalog, optionally filtered by issuer."""
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        if issuer:
            rows = await db.execute_fetchall(
                "SELECT * FROM cards WHERE issuer = ? ORDER BY name", (issuer,)
            )
        else:
            rows = await db.execute_fetchall("SELECT * FROM cards ORDER BY issuer, name")
        return [dict(r) for r in rows]

@router.get("/overrides")
async def list_overrides():
    """Return all active time-bounded reward overrides (rotating categories)."""
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        rows = await db.execute_fetchall(
            "SELECT * FROM card_reward_overrides WHERE end_date >= date('now') ORDER BY start_date"
        )
        return [dict(r) for r in rows]

# ─── Search ───────────────────────────────────────────────────────────────────
# GET /cards/search?q=chase+sapphire
# Fast fuzzy match against all card names in the catalog — no LLM, no Firecrawl.
# Returns up to 8 results ordered by match score.

@router.get("/search")
async def search_cards(q: str = Query(..., min_length=2)):
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        all_rows = await db.execute_fetchall("SELECT * FROM cards ORDER BY name")

    cards = [dict(r) for r in all_rows]
    if not cards:
        return []

    names = [c["name"] for c in cards]

    # rapidfuzz returns (match_string, score, index) tuples
    hits = fuzz_process.extract(
        q,
        names,
        scorer=fuzz.WRatio,       # token-aware ratio — handles word order well
        limit=8,
        score_cutoff=40,
    )

    results = []
    for (_, score, idx) in hits:
        results.append({"score": round(score, 1), "card": cards[idx]})

    return sorted(results, key=lambda x: x["score"], reverse=True)

# ─── Enrich ───────────────────────────────────────────────────────────────────
# POST /cards/enrich  { "query": "Amex Blue Cash Preferred" }
#
# Pipeline:
#   1. Fuzzy match catalog — if score > 85 return existing card immediately
#   2. Rate-limit check — if enriched within 24h return cached result
#   3. Firecrawl search → scrape top result
#   4. Claude Sonnet extraction via existing extractor agent
#   5. Upsert to SQLite, return full card data

class EnrichRequest(BaseModel):
    query: str

@router.post("/enrich")
async def enrich_card(req: EnrichRequest):
    query = req.query.strip()
    if len(query) < 3:
        raise HTTPException(status_code=400, detail="Query too short")

    # Detect debit card queries early — pass hint to extraction
    is_debit = any(w in query.lower() for w in ["debit", "checking", "savings"])

    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        all_rows = await db.execute_fetchall("SELECT * FROM cards ORDER BY name")

    cards = [dict(r) for r in all_rows]
    names = [c["name"] for c in cards]

    # ── Step 1: catalog fast-path ─────────────────────────────────────────────
    if cards:
        hits = fuzz_process.extract(query, names, scorer=fuzz.WRatio, limit=1, score_cutoff=85)
        if hits:
            _, score, idx = hits[0]
            return {"source": "catalog", "card": cards[idx], "confidence": round(score / 100, 2)}

    # ── Step 2: rate-limit — don't re-enrich the same card within 24h ─────────
    if cards:
        recent_hits = fuzz_process.extract(query, names, scorer=fuzz.WRatio, limit=1, score_cutoff=60)
        if recent_hits:
            _, _, idx = recent_hits[0]
            enriched_at = cards[idx].get("last_enriched_at")
            if enriched_at:
                try:
                    ts = datetime.fromisoformat(enriched_at)
                    if datetime.utcnow() - ts < timedelta(hours=24):
                        return {"source": "cached", "card": cards[idx], "confidence": 0.85}
                except Exception:
                    pass

    # ── Step 3–5: Firecrawl + Claude Sonnet extraction ────────────────────────
    try:
        # pipeline/extractor.py lives at the REPO ROOT, but server/pipeline/ also
        # exists and Python finds it first. Use importlib to load from the exact path,
        # bypassing the server/pipeline/ name collision entirely.
        import importlib.util, firecrawl
        _extractor_path = Path(__file__).resolve().parent.parent.parent / "pipeline" / "extractor.py"
        _spec = importlib.util.spec_from_file_location("root_extractor", _extractor_path)
        _mod  = importlib.util.module_from_spec(_spec)       # type: ignore[arg-type]
        _spec.loader.exec_module(_mod)                        # type: ignore[union-attr]
        extraction_agent = _mod.extractor
        upsert_card      = _mod.upsert_card
        make_card_id     = _mod.make_card_id

        from firecrawl.v2.types import ScrapeOptions
        fc = firecrawl.FirecrawlApp(api_key=os.getenv("FIRECRAWL_API_KEY", ""))

        # Firecrawl v4 search — prefer official issuer pages
        OFFICIAL_DOMAINS = [
            "creditcards.chase.com", "americanexpress.com", "capitalone.com",
            "citi.com", "discover.com", "bankofamerica.com", "wellsfargo.com",
            "nerdwallet.com", "usbank.com",
        ]
        search_results = fc.search(
            f'"{query}" credit card rewards',
            limit=3,
            include_domains=OFFICIAL_DOMAINS,
            scrape_options=ScrapeOptions(formats=["markdown"]),
        )

        # v4 returns SearchData with .web list of Document objects
        docs = search_results.web or []
        urls = [
            (d.metadata.url or d.metadata.source_url or "")
            for d in docs
            if d.metadata
        ]
        urls = [u for u in urls if u]

        if not urls:
            raise HTTPException(status_code=404, detail=f"No pages found for '{query}'")

        top_url  = urls[0]
        top_doc  = docs[0]

        # Content may already be in the search result (scrape_options requested markdown)
        content = (top_doc.markdown or "")[:8000]

        # If search didn't return content, scrape the URL directly
        if not content:
            scraped = fc.scrape_url(top_url, formats=["markdown"])
            content = (scraped.markdown or "")[:8000]

        if not content:
            raise HTTPException(status_code=422, detail="Could not extract page content")

        debit_hint = "\nThis appears to be a DEBIT card — set card_type: 'debit'." if is_debit else ""
        result = await extraction_agent.run(
            f"Extract card data from this page. Card query: {query}{debit_hint}\n\n{content}"
        )
        extracted = result.output

        # Upsert into SQLite, mark enrichment timestamp
        import hashlib
        content_hash = hashlib.md5(content.encode()).hexdigest()
        card_id = make_card_id(extracted.name, extracted.issuer)

        async with aiosqlite.connect(DB_PATH) as db:
            await upsert_card(db, extracted, top_url, content_hash)
            await db.execute(
                "UPDATE cards SET last_enriched_at = ? WHERE id = ?",
                (datetime.utcnow().isoformat(), card_id)
            )
            await db.commit()
            db.row_factory = aiosqlite.Row
            row = await db.execute_fetchall("SELECT * FROM cards WHERE id = ?", (card_id,))

        card_data = dict(row[0]) if row else {}

        # Confidence: high if we scraped an official issuer page, lower for NerdWallet
        official_domains = ["chase.com", "americanexpress.com", "capitalone.com",
                            "citi.com", "discover.com", "bankofamerica.com"]
        confidence = 0.92 if any(d in top_url for d in official_domains) else 0.72

        return {"source": "enriched", "card": card_data, "confidence": confidence}

    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Enrichment failed: {e}")

# ─── Existing single-card route (must be LAST — catches /{card_id}) ──────────

@router.get("/{card_id}")
async def get_card(card_id: str):
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        row = await db.execute_fetchall("SELECT * FROM cards WHERE id = ?", (card_id,))
        if not row:
            raise HTTPException(status_code=404, detail="Card not found")
        return dict(row[0])

# ─── Helper ───────────────────────────────────────────────────────────────────

def _domain(url: str) -> str:
    try:
        from urllib.parse import urlparse
        return urlparse(url).netloc.replace("www.", "")
    except Exception:
        return url
