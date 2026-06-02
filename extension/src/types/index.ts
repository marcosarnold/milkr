// ─── Card catalog ────────────────────────────────────────────────────────────

export type Network = 'visa' | 'mastercard' | 'amex' | 'discover';
export type CardType = 'credit' | 'debit' | 'prepaid';
export type RewardType = 'cashback' | 'points' | 'miles' | 'flex';
export type RedemptionPreference = 'cash' | 'travel_portal' | 'transfer_partners';

export type MerchantCategory =
  | 'DINING'
  | 'GROCERIES'
  | 'TRAVEL'
  | 'GAS'
  | 'ECOMMERCE'
  | 'ENTERTAINMENT'
  | 'STREAMING'
  | 'DRUGSTORE'
  | 'TRANSIT'
  | 'OTHER';

export interface RewardRates {
  dining: number;
  groceries: number;
  travel: number;
  gas: number;
  ecommerce: number;
  entertainment: number;
  streaming: number;
  drugstore: number;
  transit: number;
  other: number;
}

export interface CatalogCard {
  id: string;
  name: string;
  issuer: string;
  network: Network;
  cardType: CardType;
  annualFee: number;
  rewardType: RewardType;
  /** Cents per point/mile — e.g. 0.01 for 1cpp cash, 0.015 for 1.5cpp portal */
  pointValue: number;
  rewardRates: RewardRates;
  hasRewards: boolean;
  rotatingCategories: boolean;
  foreignTransactionFee: boolean;
  /** Merchant IDs where this card is NOT accepted — e.g. amex at costco */
  notAcceptedAt: string[];
  /** Merchant IDs where bonus category is explicitly excluded */
  categoryExclusions: { category: MerchantCategory; excludedMerchants: string[] }[];
  /** Annual spend cap per category in dollars — null = no cap */
  annualCaps: Partial<Record<MerchantCategory, number>>;
  sourceUrl?: string;
}

// ─── User wallet ─────────────────────────────────────────────────────────────

export interface WalletCard {
  id: string;                         // user-assigned uuid
  catalogId: string;                  // foreign key → CatalogCard.id
  nickname?: string;
  cardType: CardType;
  redemptionPreference: RedemptionPreference;
  /** Cumulative spend per category this period — for cap tracking */
  periodSpend: Partial<Record<MerchantCategory, number>>;
  addedAt: string;                    // ISO timestamp
}

// ─── Merchant detection ───────────────────────────────────────────────────────

export interface BNPLAvailability {
  klarna: boolean;
  affirm: boolean;
  afterpay: boolean;
}

export interface MerchantContext {
  url: string;
  domain: string;
  merchantName: string;
  category: MerchantCategory;
  /** 4-digit ISO 18245 code resolved from domain→MCC lookup */
  mcc: string | null;
  transactionAmount: number | null;
  bnpl: BNPLAvailability;
  /** True when merchant is context-dependent (e.g. Target café vs Target retail) */
  contextDependent: boolean;
  confidence: number;                 // 0.0–1.0
  detectedAt: number;                 // Date.now()
}

// ─── Reward resolution ───────────────────────────────────────────────────────

export interface ResolvedRate {
  rate: number;
  /** Dollar value returned: amount × rate × pointValue */
  expectedValue: number;
  isRotating: boolean;
  requiresActivation: boolean;
  /** Blended rate applied when transaction crosses a spending cap boundary */
  isBlended: boolean;
  /** ISO date string if a time-bounded override is active */
  overrideExpires: string | null;
  /** < 0.8 triggers a stale warning in UI */
  confidence: number;
  rationale: string;
}

export interface RankedCard {
  wallet: WalletCard;
  catalog: CatalogCard;
  resolved: ResolvedRate;
}

export interface Recommendation {
  merchantContext: MerchantContext;
  ranked: RankedCard[];
  bnplOptions: BNPLOption[];
  giftCardTip: string | null;
  generatedAt: number;
}

export interface BNPLOption {
  provider: 'klarna' | 'affirm' | 'afterpay';
  available: boolean;
  installments: number;               // typically 4
  installmentAmount: number | null;   // transactionAmount / installments
  isInterestFree: boolean;
  requiresCreditCheck: boolean;
}

// ─── Override table (rotating rewards) ───────────────────────────────────────

export interface RewardOverride {
  id: string;
  cardId: string;
  category: MerchantCategory;
  rate: number;
  capDollars: number | null;
  startDate: string;                  // YYYY-MM-DD
  endDate: string;                    // YYYY-MM-DD
  requiresActivation: boolean;
  sourceUrl: string;
  confidence: number;
  createdAt: string;
}

// ─── History ─────────────────────────────────────────────────────────────────

export interface RecommendationHistoryEntry {
  id: string;
  domain: string;
  merchantName: string;
  category: string;
  transactionAmount: number | null;
  chosenCardId: string | null;
  expectedValue: number | null;
  generatedAt: number;
}

// ─── User preferences ────────────────────────────────────────────────────────

export interface UserPreferences {
  defaultRedemption: RedemptionPreference;
  showBNPL: boolean;
  showGiftCardTips: boolean;
  internationalMode: boolean;
  hasSeenOnboarding: boolean;
}
