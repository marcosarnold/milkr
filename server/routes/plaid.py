import os, uuid
from fastapi import APIRouter, HTTPException
from fastapi.responses import HTMLResponse
from pydantic import BaseModel
import plaid
import aiosqlite
from rapidfuzz import fuzz
from db.database import DB_PATH
from plaid.api import plaid_api
from plaid.model.link_token_create_request import LinkTokenCreateRequest
from plaid.model.link_token_create_request_user import LinkTokenCreateRequestUser
from plaid.model.item_public_token_exchange_request import ItemPublicTokenExchangeRequest
from plaid.model.liabilities_get_request import LiabilitiesGetRequest
from plaid.model.products import Products
from plaid.model.country_code import CountryCode

router = APIRouter()

# ─── Plaid client ─────────────────────────────────────────────────────────────

_ENV_MAP = {
    "sandbox":    plaid.Environment.Sandbox,
    "production": plaid.Environment.Production,
}

configuration = plaid.Configuration(
    host=_ENV_MAP.get(os.getenv("PLAID_ENV", "sandbox"), plaid.Environment.Sandbox),
    api_key={
        "clientId": os.getenv("PLAID_CLIENT_ID", ""),
        "secret":   os.getenv("PLAID_SECRET", ""),
    },
)
plaid_client = plaid_api.PlaidApi(plaid.ApiClient(configuration))

# ─── In-memory session store ─────────────────────────────────────────────────
# Stores completed Plaid imports keyed by a short-lived session token.
# Cleared when server restarts — fine for dev/sandbox.
_sessions: dict[str, list] = {}

# ─── Link token ───────────────────────────────────────────────────────────────

class LinkTokenRequest(BaseModel):
    user_id: str

@router.post("/link-token")
async def create_link_token(req: LinkTokenRequest):
    """Create a Plaid Link token + a session token the extension uses to poll for results."""
    try:
        response = plaid_client.link_token_create(
            LinkTokenCreateRequest(
                user=LinkTokenCreateRequestUser(client_user_id=req.user_id),
                client_name="Milkr",
                products=[Products("liabilities")],
                country_codes=[CountryCode("US")],
                language="en",
            )
        )
        session_token = str(uuid.uuid4())
        _sessions[session_token] = []   # reserve slot
        return {"link_token": response["link_token"], "session_token": session_token}
    except plaid.ApiException as e:
        raise HTTPException(status_code=400, detail=str(e))

# ─── Server-hosted Plaid Link page ───────────────────────────────────────────
# Opened by the extension as a regular browser tab — no extension CSP applies.

@router.get("/link", response_class=HTMLResponse)
async def plaid_link_page(token: str, session: str):
    """Serve the Plaid Link UI as a normal web page. Opens in a browser tab."""
    html = f"""<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Milkr — Connect Bank</title>
  <script src="https://cdn.plaid.com/link/v2/stable/link-initialize.js"></script>
  <style>
    *{{box-sizing:border-box;margin:0;padding:0}}
    body{{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#f9fafb;
         display:flex;align-items:center;justify-content:center;min-height:100vh}}
    .card{{background:#fff;border-radius:16px;padding:40px 32px;max-width:380px;width:100%;
           text-align:center;box-shadow:0 4px 24px rgba(0,0,0,.08)}}
    .logo{{font-weight:800;font-size:18px;color:#1D9E75;margin-bottom:24px}}
    h1{{font-size:18px;font-weight:700;color:#111;margin-bottom:8px}}
    p{{font-size:13px;color:#6b7280;line-height:1.6}}
    .spin{{display:inline-block;width:28px;height:28px;border:3px solid #e5e7eb;
           border-top-color:#1D9E75;border-radius:50%;animation:spin .8s linear infinite;margin:20px auto 0}}
    @keyframes spin{{to{{transform:rotate(360deg)}}}}
    #status{{margin-top:16px;font-size:12px;color:#9ca3af}}
    #err{{color:#ef4444;margin-top:16px;font-size:13px;display:none}}
  </style>
</head>
<body>
  <div class="card">
    <div class="logo">milkr</div>
    <h1 id="title">Connecting to your bank</h1>
    <p>We only read card names — no account numbers or balances are stored.</p>
    <div class="spin" id="spin"></div>
    <div id="status">Opening Plaid…</div>
    <div id="err"></div>
  </div>
  <script>
    const SESSION = "{session}";
    const API     = window.location.origin;

    function status(msg) {{ document.getElementById('status').textContent = msg; }}
    function error(msg) {{
      document.getElementById('spin').style.display  = 'none';
      document.getElementById('err').style.display   = 'block';
      document.getElementById('err').textContent     = msg;
      document.getElementById('title').textContent   = 'Something went wrong';
    }}

    const handler = Plaid.create({{
      token: "{token}",
      onSuccess: async function(public_token) {{
        status('Importing your cards…');
        try {{
          const r = await fetch(API + '/plaid/complete', {{
            method: 'POST',
            headers: {{'Content-Type': 'application/json'}},
            body: JSON.stringify({{ session_token: SESSION, public_token }})
          }});
          if (!r.ok) throw new Error(await r.text());
          document.getElementById('title').textContent = 'All done!';
          document.getElementById('spin').style.display = 'none';
          status('Your cards are ready in Milkr. You can close this tab.');
        }} catch(e) {{ error(e.message); }}
      }},
      onExit: function(err) {{
        if (err) error(JSON.stringify(err));
        else window.close();
      }},
      onLoad: function() {{ status('Follow the prompts above.'); }}
    }});
    handler.open();
  </script>
</body>
</html>"""
    return HTMLResponse(html)

# ─── Complete (called by server page after Plaid success) ────────────────────

class CompleteRequest(BaseModel):
    session_token: str
    public_token: str

@router.post("/complete")
async def complete_plaid(req: CompleteRequest):
    """Exchange public_token, fetch liabilities, store result in session."""
    if req.session_token not in _sessions:
        raise HTTPException(status_code=404, detail="Unknown session")
    try:
        ex = plaid_client.item_public_token_exchange(
            ItemPublicTokenExchangeRequest(public_token=req.public_token)
        )
        wallet_resp = plaid_client.liabilities_get(
            LiabilitiesGetRequest(access_token=ex["access_token"])
        )
        cards = []
        for card in wallet_resp["liabilities"].get("credit", []):
            cards.append({
                "plaid_account_id": card.get("account_id"),
                "name":             card.get("name", ""),
                "last_four":        card.get("last_four"),
                "issuer":           card.get("institution_name", ""),
            })
        _sessions[req.session_token] = cards
        return {"status": "ok", "card_count": len(cards)}
    except plaid.ApiException as e:
        raise HTTPException(status_code=400, detail=str(e))

# ─── Result poll (called by extension after returning from bank tab) ──────────

@router.get("/result/{session_token}")
async def get_result(session_token: str):
    """Return completed Plaid cards for this session, or 404 if not ready."""
    if session_token not in _sessions:
        raise HTTPException(status_code=404, detail="Session not found")
    cards = _sessions[session_token]
    if not cards:
        raise HTTPException(status_code=202, detail="Pending — not complete yet")
    # Clean up after reading
    del _sessions[session_token]
    return {"cards": cards}

# ─── Card matching ────────────────────────────────────────────────────────────

@router.post("/match")
async def match_cards(body: dict):
    """
    Given a list of Plaid-returned card objects [{name, last_four, issuer}],
    fuzzy-match each against the catalog and return the best hit per card.
    Threshold: 0.5 — below that we return no match so the user can search manually.
    """
    plaid_cards: list = body.get("cards", [])
    if not plaid_cards:
        return {"matches": []}

    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        catalog = await db.execute_fetchall("SELECT id, name, issuer FROM cards")

    matches = []
    for pc in plaid_cards:
        plaid_name = pc.get("name", "")
        best_id    = None
        best_name  = None
        best_score = 0.0

        for cc in catalog:
            score = max(
                fuzz.WRatio(plaid_name, cc["name"]),
                fuzz.WRatio(plaid_name, f'{cc["issuer"]} {cc["name"]}'),
            ) / 100.0
            if score > best_score:
                best_score = score
                best_id    = cc["id"]
                best_name  = cc["name"]

        matches.append({
            "plaid_name":           plaid_name,
            "last_four":            pc.get("last_four"),
            "issuer":               pc.get("issuer", ""),
            "matched_catalog_id":   best_id   if best_score >= 0.5 else None,
            "matched_catalog_name": best_name if best_score >= 0.5 else None,
            "confidence":           round(best_score, 3),
        })

    return {"matches": matches}
