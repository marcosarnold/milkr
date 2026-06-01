import aiosqlite
import os

DB_PATH = os.getenv("DATABASE_URL") or "milkr.db"

CREATE_CARDS = """
CREATE TABLE IF NOT EXISTS cards (
    id                    TEXT PRIMARY KEY,
    name                  TEXT NOT NULL,
    issuer                TEXT NOT NULL,
    network               TEXT NOT NULL,
    card_type             TEXT NOT NULL DEFAULT 'credit',
    annual_fee            REAL NOT NULL DEFAULT 0,
    reward_type           TEXT NOT NULL,
    point_value           REAL NOT NULL DEFAULT 0.01,
    rate_dining           REAL NOT NULL DEFAULT 1.0,
    rate_groceries        REAL NOT NULL DEFAULT 1.0,
    rate_travel           REAL NOT NULL DEFAULT 1.0,
    rate_gas              REAL NOT NULL DEFAULT 1.0,
    rate_ecommerce        REAL NOT NULL DEFAULT 1.0,
    rate_entertainment    REAL NOT NULL DEFAULT 1.0,
    rate_streaming        REAL NOT NULL DEFAULT 1.0,
    rate_drugstore        REAL NOT NULL DEFAULT 1.0,
    rate_transit          REAL NOT NULL DEFAULT 1.0,
    rate_other            REAL NOT NULL DEFAULT 1.0,
    has_rewards           INTEGER NOT NULL DEFAULT 1,
    rotating_categories   INTEGER NOT NULL DEFAULT 0,
    foreign_tx_fee        INTEGER NOT NULL DEFAULT 1,
    not_accepted_at       TEXT NOT NULL DEFAULT '[]',
    category_exclusions   TEXT NOT NULL DEFAULT '[]',
    annual_caps           TEXT NOT NULL DEFAULT '{}',
    source_url            TEXT,
    content_hash          TEXT,
    scraped_at            TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    last_verified         TIMESTAMP
);
"""

CREATE_OVERRIDES = """
CREATE TABLE IF NOT EXISTS card_reward_overrides (
    id                  TEXT PRIMARY KEY,
    card_id             TEXT NOT NULL,
    category            TEXT NOT NULL,
    rate                REAL NOT NULL,
    cap_dollars         REAL,
    start_date          DATE NOT NULL,
    end_date            DATE NOT NULL,
    requires_activation INTEGER NOT NULL DEFAULT 1,
    source_url          TEXT,
    confidence          REAL NOT NULL DEFAULT 1.0,
    created_at          TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (card_id) REFERENCES cards(id)
);
"""

CREATE_MCC_MAP = """
CREATE TABLE IF NOT EXISTS mcc_map (
    domain      TEXT PRIMARY KEY,
    mcc         TEXT NOT NULL,
    category    TEXT NOT NULL,
    updated_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
"""

async def init_db():
    async with aiosqlite.connect(DB_PATH) as db:
        await db.execute(CREATE_CARDS)
        await db.execute(CREATE_OVERRIDES)
        await db.execute(CREATE_MCC_MAP)
        await db.commit()
    print(f"Database initialised at {DB_PATH}")

async def get_db():
    return aiosqlite.connect(DB_PATH)

if __name__ == "__main__":
    import asyncio
    asyncio.run(init_db())
