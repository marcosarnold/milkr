"""
Admin routes — manual triggers for scheduled jobs.
Useful for testing without waiting for cron times.
"""
from fastapi import APIRouter, HTTPException
from pipeline.watchers.rotating import scan_quarterly_announcements, weekly_diff_check

router = APIRouter()

JOB_MAP = {
    "quarterly": scan_quarterly_announcements,
    "weekly":    weekly_diff_check,
}

@router.post("/run/{job}")
async def trigger_job(job: str):
    """Manually trigger a scheduled job. job = 'quarterly' | 'weekly'"""
    fn = JOB_MAP.get(job)
    if not fn:
        raise HTTPException(status_code=404, detail=f"Unknown job '{job}'. Valid: {list(JOB_MAP)}")
    await fn()
    return {"status": "ok", "job": job}
