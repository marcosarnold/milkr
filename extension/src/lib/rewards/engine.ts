import type {
  CatalogCard,
  WalletCard,
  MerchantContext,
  ResolvedRate,
  RankedCard,
  Recommendation,
  BNPLOption,
  MerchantCategory,
} from '@/types';
import { spendDB } from '@/lib/storage';

const GIFT_CARD_STACKING_MERCHANTS: Record<string, string> = {
  'target.com': 'Target',
  'starbucks.com': 'Starbucks',
  'amazon.com': 'Amazon',
  'walmart.com': 'Walmart',
  'bestbuy.com': 'Best Buy',
};

// ─── Main resolver ────────────────────────────────────────────────────────────

export async function buildRecommendation(
  wallet: WalletCard[],
  catalog: Map<string, CatalogCard>,
  overrides: Map<string, any>, // keyed by cardId:category
  context: MerchantContext
): Promise<Recommendation> {
  const ranked: RankedCard[] = [];

  for (const walletCard of wallet) {
    const catalogCard = catalog.get(walletCard.catalogId);
    if (!catalogCard) continue;

    // Hard filter: card not accepted at this merchant
    if (catalogCard.notAcceptedAt.includes(context.domain)) continue;

    const resolved = await resolveRate(
      walletCard,
      catalogCard,
      overrides,
      context
    );

    ranked.push({ wallet: walletCard, catalog: catalogCard, resolved });
  }

  // Sort by expected value descending; no-rewards cards go last
  ranked.sort((a, b) => b.resolved.expectedValue - a.resolved.expectedValue);

  return {
    merchantContext: context,
    ranked,
    bnplOptions: buildBNPLOptions(context),
    giftCardTip: buildGiftCardTip(context, ranked),
    generatedAt: Date.now(),
  };
}

// ─── Rate resolution ──────────────────────────────────────────────────────────

async function resolveRate(
  wallet: WalletCard,
  catalog: CatalogCard,
  overrides: Map<string, any>,
  context: MerchantContext
): Promise<ResolvedRate> {
  const { category, transactionAmount, domain } = context;
  const amount = transactionAmount ?? 0;

  // 1. Check per-card exclusions for this merchant + category
  const excluded = catalog.categoryExclusions.some(
    (e) => e.category === category && e.excludedMerchants.includes(domain)
  );

  // 2. Check for active time-bounded override (rotating / promo)
  const overrideKey = `${catalog.id}:${category}`;
  const override = overrides.get(overrideKey);
  const today = new Date().toISOString().split('T')[0];
  const activeOverride =
    override && override.startDate <= today && override.endDate >= today
      ? override
      : null;

  // 3. Determine the effective base rate
  const baseRate = excluded ? catalog.rewardRates.other : catalog.rewardRates[category as keyof typeof catalog.rewardRates] ?? catalog.rewardRates.other;
  const bonusRate = activeOverride?.rate ?? baseRate;
  const effectiveRate = excluded ? catalog.rewardRates.other : bonusRate;

  // 4. Apply spending cap — calculate blended rate if crossing boundary
  const cap = catalog.annualCaps[category] ?? null;
  let finalRate = effectiveRate;
  let isBlended = false;

  if (cap !== null && amount > 0) {
    const spent = await spendDB.getSpend(catalog.id, category);
    const remaining = Math.max(0, cap - spent);

    if (remaining <= 0) {
      // Fully over cap — use base rate
      finalRate = catalog.rewardRates.other;
    } else if (remaining < amount) {
      // Crossing the cap boundary — blended rate
      finalRate = (remaining * effectiveRate + (amount - remaining) * catalog.rewardRates.other) / amount;
      isBlended = true;
    }
  }

  // 5. Subtract foreign transaction fee if international
  const isInternational = !context.domain.endsWith('.com') && !context.domain.endsWith('.us');
  const ftfDeduction = isInternational && catalog.foreignTransactionFee ? 3.0 : 0;
  const netRate = Math.max(0, finalRate - ftfDeduction / 100);

  // 6. Apply user's redemption preference to point value
  const pointValue = getEffectivePointValue(wallet, catalog);
  const expectedValue = amount * (netRate / 100) * (catalog.rewardType === 'cashback' ? 1 : pointValue * 100);

  return {
    rate: netRate,
    expectedValue: Math.round(expectedValue * 100) / 100,
    isRotating: !!activeOverride,
    requiresActivation: activeOverride?.requiresActivation ?? false,
    isBlended,
    overrideExpires: activeOverride?.endDate ?? null,
    confidence: activeOverride?.confidence ?? 1.0,
    rationale: buildRationale(catalog, netRate, effectiveRate, excluded, activeOverride, isBlended, ftfDeduction),
  };
}

function getEffectivePointValue(wallet: WalletCard, catalog: CatalogCard): number {
  const valueMap: Record<string, number> = {
    cash: catalog.pointValue,
    travel_portal: catalog.pointValue * 1.5,
    transfer_partners: catalog.pointValue * 2.0,
  };
  return valueMap[wallet.redemptionPreference] ?? catalog.pointValue;
}

function buildRationale(
  card: CatalogCard,
  netRate: number,
  rawRate: number,
  excluded: boolean,
  override: any,
  blended: boolean,
  ftfDeduction: number
): string {
  const parts: string[] = [];

  if (excluded) parts.push(`${card.name} earns base rate here — bonus excluded at this merchant`);
  else if (override) parts.push(`${rawRate}x rotating offer active through ${override.endDate}`);
  else parts.push(`${rawRate}x on this category`);

  if (blended) parts.push('blended rate — approaching quarterly cap');
  if (ftfDeduction > 0) parts.push('3% foreign transaction fee deducted');

  return parts.join(' · ');
}

// ─── BNPL options ─────────────────────────────────────────────────────────────

function buildBNPLOptions(context: MerchantContext): BNPLOption[] {
  const amount = context.transactionAmount;
  const options: BNPLOption[] = [];

  const providers: Array<[keyof typeof context.bnpl, string]> = [
    ['afterpay', 'afterpay'],
    ['klarna', 'klarna'],
    ['affirm', 'affirm'],
  ];

  for (const [key, provider] of providers) {
    if (!context.bnpl[key]) continue;
    options.push({
      provider: provider as BNPLOption['provider'],
      available: true,
      installments: 4,
      installmentAmount: amount ? Math.round((amount / 4) * 100) / 100 : null,
      isInterestFree: true,
      requiresCreditCheck: false,
    });
  }

  return options;
}

// ─── Gift card stacking ───────────────────────────────────────────────────────

function buildGiftCardTip(context: MerchantContext, ranked: RankedCard[]): string | null {
  const merchantName = GIFT_CARD_STACKING_MERCHANTS[context.domain];
  if (!merchantName) return null;

  // Only suggest if the user has a card that earns well at grocery stores
  const groceryCard = ranked.find(
    (r) => (r.catalog.rewardRates.groceries ?? 0) >= 3
  );
  if (!groceryCard) return null;

  const groceryRate = groceryCard.catalog.rewardRates.groceries;
  const directRate = ranked[0]?.resolved.rate ?? 1;

  if (groceryRate <= directRate) return null;

  return `Buy a ${merchantName} gift card at a grocery store with your ${groceryCard.catalog.name} for ${groceryRate}x instead of ${directRate}x directly`;
}
