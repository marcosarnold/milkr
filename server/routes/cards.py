from fastapi import APIRouter, Query
from db.database import get_db
import aiosqlite, json, os

router = APIRouter()
DB_PATH = os.getenv("DATABASE_URL", "milkr.db")

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

@router.get("/{card_id}")
async def get_card(card_id: str):
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        row = await db.execute_fetchall(
            "SELECT * FROM cards WHERE id = ?", (card_id,)
        )
        if not row:
            from fastapi import HTTPException
            raise HTTPException(status_code=404, detail="Card not found")
        return dict(row[0])
