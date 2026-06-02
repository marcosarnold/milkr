import type { MerchantContext, RankedCard } from '@/types';

// ─── WhyPanel ─────────────────────────────────────────────────────────────────
// Accordion breakdown rendered inside the best-card bubble.
// All data comes from the existing Recommendation type — no extra API calls.
//
// Sections:
//   1. Dollar comparison table  — every wallet card with rate, effective ¢/dollar, $ back
//   2. Why this card wins       — plain English from rate + point value differences
//   3. Caveats                  — conditionally rendered flags from ResolvedRate
//   4. Runner-up callout        — how much the next best card earns less

interface WhyPanelProps {
  ranked: RankedCard[];
  merchantContext: MerchantContext;
}

export default function WhyPanel({ ranked, merchantContext }: WhyPanelProps) {
  const best = ranked[0];
  const runnerUp = ranked[1];

  const isInternational =
    !merchantContext.domain.endsWith('.com') &&
    !merchantContext.domain.endsWith('.us');
  const hasFTF = isInternational && best.catalog.foreignTransactionFee;

  const diff =
    runnerUp != null
      ? best.resolved.expectedValue - runnerUp.resolved.expectedValue
      : null;

  const winnerExplanation = buildWinnerExplanation(best, runnerUp, merchantContext.domain);
  const caveats = buildCaveats(best, hasFTF);

  return (
    <div className="mt-3 pt-3 border-t border-[#1D9E75]/15 space-y-3">

      {/* ── 1. Dollar comparison table ── */}
      <div>
        <div className="flex items-center justify-between mb-1.5">
          <p className="text-[10px] font-semibold uppercase tracking-wider text-gray-400">
            Breakdown
          </p>
          {/* Column headers */}
          <div className="flex gap-3 text-[9px] font-medium text-gray-300 uppercase tracking-wider pr-0.5">
            <span className="w-8 text-right">Rate</span>
            <span className="w-16 text-right">¢/dollar</span>
            <span className="w-12 text-right">$ back</span>
          </div>
        </div>
        <div className="space-y-0.5">
          {ranked.map((card, i) => (
            <ComparisonRow
              key={card.wallet.id}
              card={card}
              isWinner={i === 0}
              amount={merchantContext.transactionAmount}
            />
          ))}
        </div>
      </div>

      {/* ── 2. Why this card wins ── */}
      {winnerExplanation && (
        <div>
          <p className="text-[10px] font-semibold uppercase tracking-wider text-gray-400 mb-1">
            Why this wins
          </p>
          <p className="text-xs text-gray-600 leading-relaxed">{winnerExplanation}</p>
        </div>
      )}

      {/* ── 3. Caveats ── only rendered when at least one applies */}
      {caveats.length > 0 && (
        <div className="space-y-1">
          {caveats.map((c, i) => (
            <p key={i} className="text-[11px] text-gray-500 leading-snug">{c}</p>
          ))}
        </div>
      )}

      {/* ── 4. Runner-up callout ── */}
      {runnerUp != null && (
        <div className="rounded-lg bg-gray-50 px-2.5 py-2">
          <p className="text-[11px] text-gray-500 leading-snug">
            Next best:{' '}
            <span className="font-medium text-gray-700">{runnerUp.catalog.name}</span>
            {diff != null && diff > 0.005 && (
              <> — earns ${diff.toFixed(2)} less at this merchant</>
            )}
          </p>
        </div>
      )}
    </div>
  );
}

// ─── Comparison row ───────────────────────────────────────────────────────────

function ComparisonRow({
  card,
  isWinner,
  amount,
}: {
  card: RankedCard;
  isWinner: boolean;
  amount: number | null;
}) {
  const { catalog, resolved } = card;

  // Effective return in cents per dollar:
  // rate × pointValue × 100  (e.g. 4x Chase UR at 0.0125 = 5.0¢/dollar)
  // This is what the user actually gets, not the raw multiplier.
  const centsPerDollar = resolved.rate * catalog.pointValue * 100;

  const dollarBack = resolved.expectedValue;
  const isExcluded = resolved.rationale.includes('excluded');

  return (
    <div
      className={`flex items-center gap-2 rounded-lg px-2 py-1.5 ${
        isWinner ? 'bg-[#1D9E75]/[0.07]' : ''
      } ${isExcluded ? 'opacity-50' : ''}`}
    >
      <span className={`text-[10px] w-3 shrink-0 ${isWinner ? 'text-[#1D9E75]' : 'text-gray-300'}`}>
        {isWinner ? '✓' : '·'}
      </span>

      {/* Card name */}
      <p className={`flex-1 text-xs truncate ${isWinner ? 'font-semibold text-gray-900' : 'text-gray-500'}`}>
        {catalog.name}
      </p>

      {/* Rate */}
      <span className={`text-xs w-8 text-right shrink-0 ${isWinner ? 'font-semibold text-[#1D9E75]' : 'text-gray-400'}`}>
        {fmtRate(resolved.rate)}x
      </span>

      {/* Effective ¢/dollar — the real comparison number */}
      <span className={`text-xs w-16 text-right shrink-0 ${isWinner ? 'font-semibold text-[#1D9E75]' : 'text-gray-400'}`}>
        {centsPerDollar.toFixed(1)}¢/$
      </span>

      {/* Dollar back — only meaningful when amount is known */}
      <span className={`text-xs w-12 text-right shrink-0 ${isWinner ? 'font-bold text-[#1D9E75]' : 'text-gray-400'}`}>
        {amount != null && dollarBack > 0 ? `$${dollarBack.toFixed(2)}` : '—'}
      </span>
    </div>
  );
}

// ─── Winner explanation builder ───────────────────────────────────────────────
// Produces a single plain-English sentence explaining why the best card wins.

function buildWinnerExplanation(
  best: RankedCard,
  runnerUp: RankedCard | undefined,
  domain: string
): string {
  if (!runnerUp) return best.resolved.rationale;

  const bestRate  = best.resolved.rate;
  const runnerRate = runnerUp.resolved.rate;
  const diff = best.resolved.expectedValue - runnerUp.resolved.expectedValue;

  // Runner-up was excluded from bonus at this merchant
  if (runnerUp.resolved.rationale.includes('excluded')) {
    const merchantName = domain.replace('www.', '').replace('.com', '');
    return `${runnerUp.catalog.name} earns base rate here — ${merchantName} is excluded from its bonus category.`;
  }

  // Best card excluded but still ranks higher (edge case)
  if (best.resolved.rationale.includes('excluded')) {
    return best.resolved.rationale;
  }

  // Different rates — lead with the rate gap
  if (Math.abs(bestRate - runnerRate) >= 0.1) {
    const extra = diff > 0.005 ? ` — $${diff.toFixed(2)} more on this order` : '';
    return `${best.catalog.name} earns ${fmtRate(bestRate)}x vs ${runnerUp.catalog.name}'s ${fmtRate(runnerRate)}x${extra}.`;
  }

  // Same rate but different point values (e.g. Chase UR vs Citi TY at same multiplier)
  const bestCpp  = best.catalog.pointValue * 100;
  const runnerCpp = runnerUp.catalog.pointValue * 100;
  if (Math.abs(bestCpp - runnerCpp) >= 0.05) {
    return `${best.catalog.name} and ${runnerUp.catalog.name} both earn ${fmtRate(bestRate)}x here, but ${best.catalog.name} points are worth more at your redemption preference (${bestCpp.toFixed(1)}¢ vs ${runnerCpp.toFixed(1)}¢ per point).`;
  }

  // Effectively identical — just surface the rationale
  return best.resolved.rationale;
}

// ─── Caveat builder ───────────────────────────────────────────────────────────

function buildCaveats(card: RankedCard, hasFTF: boolean): string[] {
  const { resolved } = card;
  const items: string[] = [];

  if (resolved.isRotating && resolved.overrideExpires) {
    items.push(`🔄 Rotating offer — active through ${resolved.overrideExpires}`);
  }
  if (resolved.requiresActivation) {
    items.push('⚠ Requires quarterly activation before using');
  }
  if (resolved.isBlended) {
    items.push('⚡ Blended rate — approaching your annual spending cap');
  }
  if (resolved.overrideExpires && daysUntil(resolved.overrideExpires) <= 7) {
    items.push(`⏰ This rate expires in ${daysUntil(resolved.overrideExpires)} days`);
  }
  if (resolved.confidence < 0.8) {
    items.push('~ Rate data may be outdated — verify with your issuer');
  }
  if (hasFTF) {
    items.push('✈ 3% foreign transaction fee deducted from expected value');
  }

  return items;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function fmtRate(rate: number): string {
  return rate % 1 === 0 ? rate.toFixed(0) : rate.toFixed(1);
}

function daysUntil(dateStr: string): number {
  return Math.ceil((new Date(dateStr).getTime() - Date.now()) / 86_400_000);
}
