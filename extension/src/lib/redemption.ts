import type { CatalogCard, RedemptionPreference } from '@/types';

// ─── RedemptionOption ─────────────────────────────────────────────────────────
// Each option carries the display label, the plain-English explanation shown
// in both WalletSetup and CardSearch, and the multiplier applied on top of
// pointValue in the engine (mirrors getEffectivePointValue() in engine.ts).

export interface RedemptionOption {
  value: RedemptionPreference;
  label: string;
  explanation: string;
  /** Factor applied to pointValue — 1.0 = cash, 1.5 = portal, 2.0 = transfers */
  multiplier: number;
}

// ─── getRedemptionOptions ─────────────────────────────────────────────────────
// Returns the available redemption options for a given card, with card-aware
// explanations. Cashback cards only get "Cash back" — no portals or transfers.

export function getRedemptionOptions(card: CatalogCard): RedemptionOption[] {
  // Cashback / debit — nothing to configure, one option only
  if (card.rewardType === 'cashback' || card.cardType === 'debit') {
    return [{
      value: 'cash',
      label: 'Cash back',
      explanation: 'Flat cashback — no portals or transfers needed. What you see is what you get.',
      multiplier: 1.0,
    }];
  }

  const issuer = card.issuer.toLowerCase();

  if (issuer.includes('chase')) {
    return [
      {
        value: 'cash',
        label: 'Cash back',
        multiplier: 1.0,
        explanation: '1 point = 1¢. 60,000 points = $600. Simple, no effort.',
      },
      {
        value: 'travel_portal',
        label: 'Portal (1.5×)',
        multiplier: 1.5,
        explanation: '1 point = 1.5¢ through Chase Travel. $600 becomes $900 in flights. Must book through Chase.',
      },
      {
        value: 'transfer_partners',
        label: 'Transfer (2×)',
        multiplier: 2.0,
        explanation: '1 point = 2¢+ transferred to United, Hyatt, or Southwest. Best value, requires some planning.',
      },
    ];
  }

  if (issuer.includes('american express') || issuer.includes('amex')) {
    return [
      {
        value: 'cash',
        label: 'Cash back',
        multiplier: 1.0,
        explanation: '1 point = 0.6¢ as a statement credit. Lowest value option.',
      },
      {
        value: 'travel_portal',
        label: 'Portal (1.5×)',
        multiplier: 1.5,
        explanation: '1 point = 1¢ through Amex Travel. Better than cash.',
      },
      {
        value: 'transfer_partners',
        label: 'Transfer (2×)',
        multiplier: 2.0,
        explanation: '1 point = 2¢+ transferred to Delta, Hilton, or British Airways. Best value.',
      },
    ];
  }

  if (issuer.includes('capital one')) {
    return [
      {
        value: 'cash',
        label: 'Cash back',
        multiplier: 1.0,
        explanation: '1 mile = 1¢ as cash back or statement credit.',
      },
      {
        value: 'travel_portal',
        label: 'Portal (1.5×)',
        multiplier: 1.5,
        explanation: '1 mile = 1¢ through Capital One Travel for flights and hotels.',
      },
      {
        value: 'transfer_partners',
        label: 'Transfer (2×)',
        multiplier: 2.0,
        explanation: '1 mile = 1.5¢+ transferred to Air Canada, Turkish Airlines, or Wyndham. Best value.',
      },
    ];
  }

  if (issuer.includes('citi')) {
    return [
      {
        value: 'cash',
        label: 'Cash back',
        multiplier: 1.0,
        explanation: '1 point = 1¢ as a statement credit or check.',
      },
      {
        value: 'travel_portal',
        label: 'Portal (1.5×)',
        multiplier: 1.5,
        explanation: '1 point = 1¢ through Citi Travel with Booking.com.',
      },
      {
        value: 'transfer_partners',
        label: 'Transfer (2×)',
        multiplier: 2.0,
        explanation: '1 point = 1.6¢+ transferred to Turkish Airlines, Air France, or Singapore Airlines.',
      },
    ];
  }

  // Generic fallback for other issuers (e.g. co-branded, enriched cards)
  return [
    {
      value: 'cash',
      label: 'Cash back',
      multiplier: 1.0,
      explanation: 'Redeem points as cash back or statement credit.',
    },
    {
      value: 'travel_portal',
      label: 'Portal (1.5×)',
      multiplier: 1.5,
      explanation: 'Redeem through the issuer travel portal for better value.',
    },
    {
      value: 'transfer_partners',
      label: 'Transfer (2×)',
      multiplier: 2.0,
      explanation: 'Transfer to airline or hotel partners for maximum value.',
    },
  ];
}

/** True when this card earns transferable points/miles (not flat cashback). */
export function isPointsCard(card: CatalogCard): boolean {
  return card.rewardType === 'points' || card.rewardType === 'miles';
}
