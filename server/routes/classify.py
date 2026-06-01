from fastapi import APIRouter
from pydantic import BaseModel, Field
import pydantic_ai
from pydantic_ai import Agent
import anthropic

router = APIRouter()

# ─── Schema ───────────────────────────────────────────────────────────────────

CATEGORIES = [
    "DINING", "GROCERIES", "TRAVEL", "GAS", "ECOMMERCE",
    "ENTERTAINMENT", "STREAMING", "DRUGSTORE", "TRANSIT", "OTHER"
]

class ClassifyRequest(BaseModel):
    domain: str
    page_title: str | None = None

class ClassifyResponse(BaseModel):
    merchant_name: str = Field(description="Clean merchant name, e.g. 'Uber Eats'")
    category: str = Field(description=f"One of: {', '.join(CATEGORIES)}")
    mcc: str | None = Field(description="4-digit ISO 18245 merchant category code if known")
    context_dependent: bool = Field(description="True if reward category may vary by transaction type")
    confidence: float = Field(ge=0.0, le=1.0)

# ─── PydanticAI agent — Claude Haiku (cheap + fast for classification) ────────

agent = Agent(
    'anthropic:claude-haiku-4-5',
    result_type=ClassifyResponse,
    system_prompt=f"""You are a credit card reward classification engine.
Given a merchant domain and optional page title, classify the merchant for credit card reward purposes.

Categories: {', '.join(CATEGORIES)}

Key rules:
- walmart.com, target.com → ECOMMERCE (NOT groceries — superstores have MCC 5310/5311)
- amazon.com → ECOMMERCE
- instacart.com, shipt.com → GROCERIES  
- ubereats.com, doordash.com, grubhub.com → DINING
- netflix.com, spotify.com, hulu.com → STREAMING
- ticketmaster.com, stubhub.com → ENTERTAINMENT
- delta.com, united.com, kayak.com → TRAVEL
- shell.com, exxon.com → GAS
- cvs.com, walgreens.com → DRUGSTORE
- Hotels with restaurants → context_dependent: true

Return the MCC if you know it with high confidence, otherwise null.
Always return valid JSON matching the schema exactly."""
)

# ─── Route ────────────────────────────────────────────────────────────────────

@router.post("/merchant", response_model=ClassifyResponse)
async def classify_merchant(req: ClassifyRequest) -> ClassifyResponse:
    prompt = f"Domain: {req.domain}"
    if req.page_title:
        prompt += f"\nPage title: {req.page_title}"

    result = await agent.run(prompt)
    return result.data
