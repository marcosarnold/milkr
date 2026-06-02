from fastapi import APIRouter
from pydantic import BaseModel, Field
from pydantic_ai import Agent

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

# ─── Local lookup — instant, zero API cost ────────────────────────────────────
# Covers the ~50 domains that account for the vast majority of checkout volume.
# Falls back to Claude Haiku only when the domain isn't recognised.
# Format: domain → (merchant_name, category, mcc, context_dependent)

_LOCAL: dict[str, tuple[str, str, str | None, bool]] = {
    # E-commerce
    "amazon.com":       ("Amazon",          "ECOMMERCE",     "5999", False),
    "walmart.com":      ("Walmart",          "ECOMMERCE",     "5310", False),
    "target.com":       ("Target",           "ECOMMERCE",     "5311", False),
    "costco.com":       ("Costco",           "ECOMMERCE",     "5300", False),
    "bestbuy.com":      ("Best Buy",         "ECOMMERCE",     "5732", False),
    "ebay.com":         ("eBay",             "ECOMMERCE",     "5999", False),
    "etsy.com":         ("Etsy",             "ECOMMERCE",     "5999", False),
    "apple.com":        ("Apple",            "ECOMMERCE",     "5045", False),
    "nike.com":         ("Nike",             "ECOMMERCE",     "5661", False),
    "adidas.com":       ("Adidas",           "ECOMMERCE",     "5661", False),
    "chewy.com":        ("Chewy",            "ECOMMERCE",     "5999", False),
    "wayfair.com":      ("Wayfair",          "ECOMMERCE",     "5712", False),
    "homedepot.com":    ("Home Depot",       "ECOMMERCE",     "5200", False),
    "lowes.com":        ("Lowe's",           "ECOMMERCE",     "5211", False),
    # Dining
    "ubereats.com":     ("Uber Eats",        "DINING",        "5812", False),
    "doordash.com":     ("DoorDash",         "DINING",        "5812", False),
    "grubhub.com":      ("Grubhub",          "DINING",        "5812", False),
    "seamless.com":     ("Seamless",         "DINING",        "5812", False),
    "postmates.com":    ("Postmates",        "DINING",        "5812", False),
    "opentable.com":    ("OpenTable",        "DINING",        "5812", False),
    "starbucks.com":    ("Starbucks",        "DINING",        "5814", False),
    "chipotle.com":     ("Chipotle",         "DINING",        "5812", False),
    "dominos.com":      ("Domino's",         "DINING",        "5812", False),
    # Groceries
    "instacart.com":    ("Instacart",        "GROCERIES",     "5411", False),
    "shipt.com":        ("Shipt",            "GROCERIES",     "5411", False),
    "kroger.com":       ("Kroger",           "GROCERIES",     "5411", False),
    "wholefoodsmarket.com": ("Whole Foods",  "GROCERIES",     "5411", False),
    "safeway.com":      ("Safeway",          "GROCERIES",     "5411", False),
    "publix.com":       ("Publix",           "GROCERIES",     "5411", False),
    "traderjoes.com":   ("Trader Joe's",     "GROCERIES",     "5411", False),
    # Streaming
    "netflix.com":      ("Netflix",          "STREAMING",     "5815", False),
    "spotify.com":      ("Spotify",          "STREAMING",     "5815", False),
    "hulu.com":         ("Hulu",             "STREAMING",     "5815", False),
    "disneyplus.com":   ("Disney+",          "STREAMING",     "5815", False),
    "hbomax.com":       ("Max",              "STREAMING",     "5815", False),
    "max.com":          ("Max",              "STREAMING",     "5815", False),
    "peacocktv.com":    ("Peacock",          "STREAMING",     "5815", False),
    "paramountplus.com":("Paramount+",       "STREAMING",     "5815", False),
    "primevideo.com":   ("Prime Video",      "STREAMING",     "5815", False),
    "youtube.com":      ("YouTube",          "STREAMING",     "5815", False),
    # Travel
    "delta.com":        ("Delta Air Lines",  "TRAVEL",        "3058", False),
    "united.com":       ("United Airlines",  "TRAVEL",        "3020", False),
    "aa.com":           ("American Airlines","TRAVEL",        "3001", False),
    "southwest.com":    ("Southwest",        "TRAVEL",        "3032", False),
    "jetblue.com":      ("JetBlue",          "TRAVEL",        "3035", False),
    "expedia.com":      ("Expedia",          "TRAVEL",        "4722", False),
    "kayak.com":        ("Kayak",            "TRAVEL",        "4722", False),
    "booking.com":      ("Booking.com",      "TRAVEL",        "7011", False),
    "airbnb.com":       ("Airbnb",           "TRAVEL",        "7011", False),
    "marriott.com":     ("Marriott",         "TRAVEL",        "7011", False),
    "hilton.com":       ("Hilton",           "TRAVEL",        "7011", False),
    "hotels.com":       ("Hotels.com",       "TRAVEL",        "7011", False),
    "vrbo.com":         ("VRBO",             "TRAVEL",        "7011", False),
    # Gas
    "shell.com":        ("Shell",            "GAS",           "5541", False),
    "exxon.com":        ("ExxonMobil",       "GAS",           "5541", False),
    "bp.com":           ("BP",               "GAS",           "5541", False),
    "chevron.com":      ("Chevron",          "GAS",           "5541", False),
    "mobil.com":        ("Mobil",            "GAS",           "5541", False),
    # Drugstore
    "cvs.com":          ("CVS",              "DRUGSTORE",     "5912", False),
    "walgreens.com":    ("Walgreens",        "DRUGSTORE",     "5912", False),
    "riteaid.com":      ("Rite Aid",         "DRUGSTORE",     "5912", False),
    # Transit
    "lyft.com":         ("Lyft",             "TRANSIT",       "4121", False),
    "uber.com":         ("Uber",             "TRANSIT",       "4121", True),  # could be Eats
    # Entertainment
    "ticketmaster.com": ("Ticketmaster",     "ENTERTAINMENT", "7922", False),
    "stubhub.com":      ("StubHub",          "ENTERTAINMENT", "7922", False),
    "fandango.com":     ("Fandango",         "ENTERTAINMENT", "7832", False),
    "amctheatres.com":  ("AMC Theatres",     "ENTERTAINMENT", "7832", False),
    "steampowered.com": ("Steam",            "ENTERTAINMENT", "5816", False),
}

def _local_classify(domain: str) -> ClassifyResponse | None:
    """Strip www/subdomains and check against the local lookup table."""
    # Normalise: strip leading www. / app. / checkout. etc.
    bare = domain.lower()
    for prefix in ("www.", "app.", "checkout.", "shop.", "m.", "pay.", "order."):
        if bare.startswith(prefix):
            bare = bare[len(prefix):]
            break

    match = _LOCAL.get(bare)
    if match is None:
        return None

    name, category, mcc, ctx_dep = match
    return ClassifyResponse(
        merchant_name=name,
        category=category,
        mcc=mcc,
        context_dependent=ctx_dep,
        confidence=0.97,   # high confidence for hardcoded entries
    )

# ─── PydanticAI agent — Claude Haiku (cheap + fast for unknown merchants) ─────

agent = Agent(
    'anthropic:claude-haiku-4-5',
    output_type=ClassifyResponse,
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
    # Fast path — no API call for known domains
    local = _local_classify(req.domain)
    if local:
        return local

    # Slow path — Claude Haiku for anything not in the local table
    prompt = f"Domain: {req.domain}"
    if req.page_title:
        prompt += f"\nPage title: {req.page_title}"

    result = await agent.run(prompt)
    return result.output
