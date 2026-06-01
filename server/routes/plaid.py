import os
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
import plaid
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
    "sandbox": plaid.Environment.Sandbox,
    "production": plaid.Environment.Production,
}

configuration = plaid.Configuration(
    host=_ENV_MAP.get(os.getenv("PLAID_ENV", "sandbox"), plaid.Environment.Sandbox),
    api_key={
        "clientId": os.getenv("PLAID_CLIENT_ID", ""),
        "secret": os.getenv("PLAID_SECRET", ""),
    },
)
plaid_client = plaid_api.PlaidApi(plaid.ApiClient(configuration))

# ─── Routes ───────────────────────────────────────────────────────────────────

class LinkTokenRequest(BaseModel):
    user_id: str

class ExchangeRequest(BaseModel):
    public_token: str
    user_id: str

@router.post("/link-token")
async def create_link_token(req: LinkTokenRequest):
    """Create a Plaid Link token to open the Link modal in the extension."""
    try:
        response = plaid_client.link_token_create(
            LinkTokenCreateRequest(
                user=LinkTokenCreateRequestUser(client_user_id=req.user_id),
                client_name="Milkr",
                products=[Products("liabilities")],
                country_codes=[CountryCode("US")],
                language="en",
                account_filters={
                    "credit": {"account_subtypes": ["credit card"]}
                },
            )
        )
        return {"link_token": response["link_token"]}
    except plaid.ApiException as e:
        raise HTTPException(status_code=400, detail=str(e))

@router.post("/exchange")
async def exchange_token(req: ExchangeRequest):
    """Exchange public_token for access_token after user completes Link."""
    try:
        response = plaid_client.item_public_token_exchange(
            ItemPublicTokenExchangeRequest(public_token=req.public_token)
        )
        # In production: store access_token securely per user_id in your DB
        # For now return it — extension stores in chrome.storage.local (user-only)
        return {
            "access_token": response["access_token"],
            "item_id": response["item_id"],
        }
    except plaid.ApiException as e:
        raise HTTPException(status_code=400, detail=str(e))

@router.post("/wallet")
async def get_wallet(body: dict):
    """Fetch user's credit cards from Plaid and return normalized card list."""
    access_token: str = body.get("access_token", "")
    if not access_token:
        raise HTTPException(status_code=400, detail="access_token required")

    try:
        response = plaid_client.liabilities_get(
            LiabilitiesGetRequest(access_token=access_token)
        )
        cards = []
        for card in response["liabilities"].get("credit", []):
            cards.append({
                "plaid_account_id": card.get("account_id"),
                "name": card.get("name", ""),
                "last_four": card.get("last_four"),
                "issuer": card.get("institution_name", ""),
                "credit_limit": card.get("balance", {}).get("limit"),
                "current_balance": card.get("balance", {}).get("current"),
                "available_credit": card.get("balance", {}).get("available"),
                "next_payment_due": str(card.get("next_payment_due_date", "")),
                "minimum_payment": card.get("minimum_payment_amount"),
            })
        return {"cards": cards}
    except plaid.ApiException as e:
        raise HTTPException(status_code=400, detail=str(e))
