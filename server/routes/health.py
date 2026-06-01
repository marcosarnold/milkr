from fastapi import APIRouter
import anthropic, os

router = APIRouter()

@router.get("/health")
async def health():
    return {
        "status": "ok",
        "anthropic": bool(os.getenv("ANTHROPIC_API_KEY")),
        "firecrawl": bool(os.getenv("FIRECRAWL_API_KEY")),
        "plaid": bool(os.getenv("PLAID_CLIENT_ID")),
    }
