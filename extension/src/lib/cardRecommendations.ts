/**
 * Personalized card recommendation engine — runs entirely client-side.
 *
 * Pipeline:
 *   1. Load last 90 days of checkout history from IndexedDB
 *   2. Aggregate spend by MCC category
 *   3. Compute what the user currently earns across categories with their wallet
 *   4. Simulate each non-wallet card against that same spend history
 *   5. Filter out cards where the delta is too small or annual fee never pays back
 *   6. Assign to display tiers: Best fit / Worth considering / No annual fee
 *
 * No server call, no credit score, no income assumptions — purely spend-based.
 */

import type { CatalogCard, RewardRates, WalletCard } from '@/types';
import { historyDB } from '@/lib/storage';

// ─── Output types ─────────────────────────────────────────────────────────────

export type RecommendationTier = 'best-fit' | 'worth-considering' | 'no-annual-fee';

export interface CardRecommendation {
  card: CatalogCard;
  tier: RecommendationTier;
  /** Monthly incremental earnings vs user's current best card per category */
  deltaMonthly: number;
  /** 90-day incremental total — used for the payback calculation */
  delta90: number;
  /**
   * null = no annual fee
   * Positive number = months until the annual fee is recovered at current delta
   */
  paybackMonths: number | null;
  /** Top 2 categories where this card specifically beats the current wallet */
  topReasons: { category: string; rate: number; monthlyGain: number }[];
}

export interface SpendSummary {
  /** Total spend per category over the trailing 90 days */
  categorySpend: Record<string, number>;
  totalSpend: number;
  transactionCount: number;
  /** Top 3 categories by spend — shown in UI subtitle */
  topCategories: { category: string; spend: number }[];
}

export interface RecommendationResult {
  recommendations: CardRecommendation[];
  summary: SpendSummary;
  /** Convenience: how to gate the UI on history depth */
  historyTier: 'too-few' | 'limited' | 'full';
}

// ─── Main export ──────────────────────────────────────────────────────────────

export async function computeRecommendations(
  wallet: WalletCard[],
  catalog: CatalogCard[],
): Promise<RecommendationResult> {
  // ── 1. Load + filter trailing 90 days ─────────────────────────────────────
  const allEntries  = await historyDB.recent(500);
  const cutoff      = Date.now() - 90 * 24 * 60 * 60 * 1000;
  const recent      = allEntries.filter(e => e.generatedAt >= cutoff && e.transactionAmount != null);
  const count       = recent.length;

  const historyTier: RecommendationResult['historyTier'] =
    count < 3  ? 'too-few'  :
    count < 10 ? 'limited'  :
                 'full';

  // ── 2. Aggregate spend by category ────────────────────────────────────────
  const categorySpend: Record<string, number> = {};
  let totalSpend = 0;

  for (const entry of recent) {
    if (!entry.transactionAmount) continue;
    const cat = (entry.category ?? 'OTHER').toUpperCase();
    categorySpend[cat] = (categorySpend[cat] ?? 0) + entry.transactionAmount;
    totalSpend += entry.transactionAmount;
  }

  const topCategories = Object.entries(categorySpend)
    .sort(([, a], [, b]) => b - a)
    .slice(0, 3)
    .map(([category, spend]) => ({ category, spend }));

  const summary: SpendSummary = { categorySpend, totalSpend, transactionCount: count, topCategories };

  if (historyTier === 'too-few') {
    return { recommendations: [], summary, historyTier };
  }

  // ── 3. Compute current best earnings per category ─────────────────────────
  // We assume the user uses their best card in each category (optimistic baseline).
  const catalogMap = new Map(catalog.map(c => [c.id, c]));
  const walletIds  = new Set(wallet.map(w => w.catalogId));

  const currentBest = computeCurrentBestEarnings(wallet, catalogMap, categorySpend);
  const totalCurrent90 = Object.values(currentBest).reduce((s, v) => s + v, 0);

  // ── 4. Score every non-wallet card ────────────────────────────────────────
  const scored: CardRecommendation[] = [];

  for (const candidate of catalog) {
    if (walletIds.has(candidate.id)) continue; // skip cards user already has

    const { projected90, categoryGains } = simulateCard(candidate, categorySpend, currentBest);
    const delta90      = projected90 - totalCurrent90;
    const deltaMonthly = delta90 / 3;          // 90 days ≈ 3 months
    const deltaAnnual  = deltaMonthly * 12;

    // ── 5. Filters ──────────────────────────────────────────────────────────
    if (delta90 < 5) continue; // less than $5 over 90 days — not compelling

    let paybackMonths: number | null = null;
    if (candidate.annualFee > 0) {
      if (deltaAnnual <= 0) continue;           // fee never recovers
      paybackMonths = candidate.annualFee / deltaMonthly;
      if (paybackMonths > 18) continue;         // too long — not worth recommending
    }

    const topReasons = categoryGains
      .sort((a, b) => b.monthlyGain - a.monthlyGain)
      .slice(0, 2);

    scored.push({
      card: candidate,
      tier: 'worth-considering', // assigned below
      deltaMonthly,
      delta90,
      paybackMonths,
      topReasons,
    });
  }

  // ── 6. Rank + assign tiers ─────────────────────────────────────────────────
  scored.sort((a, b) => b.deltaMonthly - a.deltaMonthly);
  const tiered = assignTiers(scored);

  return { recommendations: tiered.slice(0, 3), summary, historyTier };
}

// ─── Internal helpers ─────────────────────────────────────────────────────────

/**
 * For each category, find the maximum earnings the user's current wallet provides.
 * Uses the same simplified formula as the main engine: spend × rate × pointValue.
 */
function computeCurrentBestEarnings(
  wallet: WalletCard[],
  catalogMap: Map<string, CatalogCard>,
  categorySpend: Record<string, number>,
): Record<string, number> {
  const best: Record<string, number> = {};

  for (const [cat, spend] of Object.entries(categorySpend)) {
    if (!spend) continue;
    let bestValue = 0;
    for (const wc of wallet) {
      const cc = catalogMap.get(wc.catalogId);
      if (!cc) continue;
      bestValue = Math.max(bestValue, getEarnings(cc, cat, spend));
    }
    best[cat] = bestValue;
  }

  return best;
}

/** Simulate a candidate card against the user's 90-day spend profile. */
function simulateCard(
  card: CatalogCard,
  categorySpend: Record<string, number>,
  currentBest: Record<string, number>,
): { projected90: number; categoryGains: CardRecommendation['topReasons'] } {
  let projected90 = 0;
  const categoryGains: CardRecommendation['topReasons'] = [];

  for (const [cat, spend] of Object.entries(categorySpend)) {
    if (!spend) continue;
    const earnings = getEarnings(card, cat, spend);
    projected90 += earnings;

    const gain = earnings - (currentBest[cat] ?? 0);
    if (gain > 0.01) {
      categoryGains.push({
        category: cat,
        rate: getEffectiveRate(card, cat),
        monthlyGain: gain / 3,
      });
    }
  }

  return { projected90, categoryGains };
}

/** Dollar earnings for a single card × category × spend amount. */
function getEarnings(card: CatalogCard, category: string, spend: number): number {
  const excluded = card.categoryExclusions.some(e => e.category === category);
  const rate     = excluded ? card.rewardRates.other : getEffectiveRate(card, category);
  return spend * rate * card.pointValue;
}

function getEffectiveRate(card: CatalogCard, category: string): number {
  const key = category.toLowerCase() as keyof RewardRates;
  return card.rewardRates[key] ?? card.rewardRates.other;
}

/**
 * Assign display tiers to the sorted candidate list.
 * Each card appears in at most one tier; we pick the highest-value placement.
 *
 * Tier priority:
 *   "Best fit"          — best delta with fast fee payback (≤ 6 months)
 *   "Worth considering" — strong single-category advantage
 *   "No annual fee"     — best $0 fee option
 */
function assignTiers(sorted: CardRecommendation[]): CardRecommendation[] {
  if (!sorted.length) return [];

  const used   = new Set<string>();
  const result: CardRecommendation[] = [];

  function pick(predicate: (r: CardRecommendation) => boolean, tier: RecommendationTier) {
    const found = sorted.find(r => !used.has(r.card.id) && predicate(r));
    if (found) {
      result.push({ ...found, tier });
      used.add(found.card.id);
    }
  }

  // Best fit: highest delta with fee paying back within 6 months (or no fee)
  pick(r => r.paybackMonths === null || r.paybackMonths <= 6, 'best-fit');

  // Worth considering: strong in a specific category
  pick(r => r.topReasons.length > 0, 'worth-considering');

  // No annual fee: best $0 option not already shown
  pick(r => r.card.annualFee === 0, 'no-annual-fee');

  // Fill remaining slots up to 3 with any leftovers
  for (const r of sorted) {
    if (result.length >= 3) break;
    if (!used.has(r.card.id)) {
      result.push(r);
      used.add(r.card.id);
    }
  }

  return result;
}
