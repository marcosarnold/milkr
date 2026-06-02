import type { CatalogCard } from '@/types';

const API_URL = import.meta.env.VITE_API_URL ?? 'http://localhost:8000';

// ─── Classify ─────────────────────────────────────────────────────────────────

export interface ClassifyResponse {
  merchant_name: string;
  category: string;
  mcc: string | null;
  context_dependent: boolean;
  confidence: number;
}

export async function classifyMerchant(
  domain: string,
  pageTitle?: string
): Promise<ClassifyResponse> {
  const res = await fetch(`${API_URL}/classify/merchant`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ domain, page_title: pageTitle ?? null }),
  });
  if (!res.ok) throw new Error(`Classify failed: ${res.status}`);
  return res.json();
}

// ─── Catalog ──────────────────────────────────────────────────────────────────

export async function fetchCatalog(): Promise<CatalogCard[]> {
  const res = await fetch(`${API_URL}/cards/`);
  if (!res.ok) throw new Error(`Catalog fetch failed: ${res.status}`);
  const rows: unknown[] = await res.json();
  return (rows as Record<string, unknown>[]).map(rowToCatalogCard);
}

// ─── Overrides ────────────────────────────────────────────────────────────────
// Returns Map keyed by "cardId:CATEGORY" — matches engine.ts lookup convention.

export async function fetchOverrides(): Promise<Map<string, OverrideEntry>> {
  const res = await fetch(`${API_URL}/cards/overrides`);
  if (!res.ok) throw new Error(`Overrides fetch failed: ${res.status}`);
  const rows: unknown[] = await res.json();

  const map = new Map<string, OverrideEntry>();
  for (const r of rows as Record<string, unknown>[]) {
    const key = `${r.card_id}:${r.category}`;
    map.set(key, {
      rate: r.rate as number,
      capDollars: (r.cap_dollars as number | null) ?? null,
      startDate: r.start_date as string,
      endDate: r.end_date as string,
      requiresActivation: Boolean(r.requires_activation),
      confidence: r.confidence as number,
    });
  }
  return map;
}

export interface OverrideEntry {
  rate: number;
  capDollars: number | null;
  startDate: string;
  endDate: string;
  requiresActivation: boolean;
  confidence: number;
}

// ─── Search ───────────────────────────────────────────────────────────────────

export interface SearchHit {
  score: number;
  card: CatalogCard;
}

export async function searchCards(query: string): Promise<SearchHit[]> {
  const res = await fetch(`${API_URL}/cards/search?q=${encodeURIComponent(query)}`);
  if (!res.ok) throw new Error(`Search failed: ${res.status}`);
  const rows: { score: number; card: Record<string, unknown> }[] = await res.json();
  return rows.map((r) => ({ score: r.score, card: rowToCatalogCard(r.card) }));
}

// ─── Enrich ───────────────────────────────────────────────────────────────────

export interface EnrichResult {
  source: 'catalog' | 'cached' | 'enriched';
  card: CatalogCard;
  confidence: number;
}

export async function enrichCard(query: string): Promise<EnrichResult> {
  const res = await fetch(`${API_URL}/cards/enrich`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error((body as any).detail ?? `Enrich failed: ${res.status}`);
  }
  const raw = await res.json();
  return { source: raw.source, card: rowToCatalogCard(raw.card), confidence: raw.confidence };
}

// ─── Transform ────────────────────────────────────────────────────────────────
// SQLite rows come back snake_case with JSON strings for array/object columns.

function rowToCatalogCard(r: Record<string, unknown>): CatalogCard {
  const parse = (v: unknown) =>
    typeof v === 'string' ? JSON.parse(v) : v ?? [];

  return {
    id: r.id as string,
    name: r.name as string,
    issuer: r.issuer as string,
    network: r.network as CatalogCard['network'],
    cardType: r.card_type as CatalogCard['cardType'],
    annualFee: r.annual_fee as number,
    rewardType: r.reward_type as CatalogCard['rewardType'],
    pointValue: r.point_value as number,
    rewardRates: {
      dining: r.rate_dining as number,
      groceries: r.rate_groceries as number,
      travel: r.rate_travel as number,
      gas: r.rate_gas as number,
      ecommerce: r.rate_ecommerce as number,
      entertainment: r.rate_entertainment as number,
      streaming: r.rate_streaming as number,
      drugstore: r.rate_drugstore as number,
      transit: r.rate_transit as number,
      other: r.rate_other as number,
    },
    hasRewards: Boolean(r.has_rewards),
    rotatingCategories: Boolean(r.rotating_categories),
    foreignTransactionFee: Boolean(r.foreign_tx_fee),
    notAcceptedAt: parse(r.not_accepted_at) as string[],
    categoryExclusions: parse(r.category_exclusions) as CatalogCard['categoryExclusions'],
    annualCaps: parse(r.annual_caps) as CatalogCard['annualCaps'],
    sourceUrl: (r.source_url as string | null) ?? undefined,
  };
}
