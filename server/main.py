import os
from contextlib import asynccontextmanager
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from dotenv import load_dotenv
from apscheduler.schedulers.asyncio import AsyncIOScheduler

load_dotenv()

from routes.classify import router as classify_router
from routes.cards import router as cards_router
from routes.plaid import router as plaid_router
from routes.health import router as health_router
from routes.admin import router as admin_router
from pipeline.watchers.rotating import scan_quarterly_announcements, weekly_diff_check

# ─── Scheduler ────────────────────────────────────────────────────────────────

scheduler = AsyncIOScheduler(timezone="America/New_York")

def setup_schedule():
    # Weekly diff check — every Monday 9am ET
    scheduler.add_job(weekly_diff_check, 'cron', day_of_week='mon', hour=9, minute=0)

    # Quarterly announcement scanner — 15th of March, June, September, December
    scheduler.add_job(
        scan_quarterly_announcements,
        'cron',
        month='3,6,9,12',
        day=15,
        hour=8,
        minute=0,
    )

# ─── App lifecycle ────────────────────────────────────────────────────────────

@asynccontextmanager
async def lifespan(app: FastAPI):
    setup_schedule()
    scheduler.start()
    yield
    scheduler.shutdown()

# ─── App ─────────────────────────────────────────────────────────────────────

app = FastAPI(
    title="Milkr API",
    version="0.1.0",
    lifespan=lifespan,
)

# In dev, allow all origins so the extension (chrome-extension://[dynamic-id])
# can reach localhost without needing the exact ID in ALLOWED_ORIGINS.
# In prod on Railway, set ALLOWED_ORIGINS to your exact extension origin.
_raw_origins = [o.strip() for o in os.getenv("ALLOWED_ORIGINS", "").split(",") if o.strip()]
allow_all = not _raw_origins or _raw_origins == ["*"]

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"] if allow_all else _raw_origins,
    allow_origin_regex=r"chrome-extension://.*" if not allow_all else None,
    allow_credentials=False,  # must be False when allow_origins=["*"]
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(health_router)
app.include_router(classify_router, prefix="/classify")
app.include_router(cards_router, prefix="/cards")
app.include_router(plaid_router, prefix="/plaid")
app.include_router(admin_router, prefix="/admin")
