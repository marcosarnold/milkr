import { useEffect, useState } from 'react';
import type { CatalogCard, WalletCard } from '@/types';
import { walletStorage } from '@/lib/storage';
import { fetchCatalog } from '@/entrypoints/popup/api';
import {
  computeRecommendations,
  type CardRecommendation,
  type RecommendationResult,
  type RecommendationTier,
  type SpendSummary,
} from '@/lib/cardRecommendations';
import CardInfoTooltip from '@/components/CardInfoTooltip';

// ─── Category display names ───────────────────────────────────────────────────

const CAT_LABELS: Record<string, string> = {
  DINING: 'dining', GROCERIES: 'groceries', TRAVEL: 'travel',
  GAS: 'gas', ECOMMERCE: 'shopping', ENTERTAINMENT: 'entertainment',
  STREAMING: 'streaming', DRUGSTORE: 'drugstore', TRANSIT: 'transit', OTHER: 'other',
};

const TIER_META: Record<RecommendationTier, { label: string; accent: boolean }> = {
  'best-fit':          { label: '✦ Best fit',          accent: true  },
  'worth-considering': { label: 'Worth considering',    accent: false },
  'no-annual-fee':     { label: 'No annual fee',        accent: false },
};

// ─── CardRecommendations ──────────────────────────────────────────────────────
// Self-contained "For You" tab. Loads wallet + catalog, runs the scoring engine,
// and displays tiered recommendations based solely on the user's spend history.

export default function CardRecommendations() {
  const [result, setResult]   = useState<RecommendationResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [error,   setError]   = useState<string | null>(null);

  useEffect(() => {
    load();
  }, []);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const [wallet, catalog] = await Promise.all([
        walletStorage.getValue(),
        fetchCatalog(),
      ]);
      const res = await computeRecommendations(wallet, catalog);
      setResult(res);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load recommendations');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="w-[380px] bg-white">
      {loading && <LoadingSkeleton />}
      {error   && <ErrorState msg={error} onRetry={load} />}
      {result  && !loading && <ResultsView result={result} />}
    </div>
  );
}

// ─── Results view ─────────────────────────────────────────────────────────────

function ResultsView({ result }: { result: RecommendationResult }) {
  const { recommendations, summary, historyTier } = result;

  return (
    <div className="divide-y divide-gray-100">
      <Header summary={summary} historyTier={historyTier} />

      {historyTier === 'too-few' ? (
        <TooFewCheckouts count={summary.transactionCount} />
      ) : recommendations.length === 0 ? (
        <NoRecommendations />
      ) : (
        <div className="divide-y divide-gray-100">
          {recommendations.map((rec, i) => (
            <RecommendationCard
              key={rec.card.id}
              rec={rec}
              isFirst={i === 0}
              historyTier={historyTier}
            />
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Header ───────────────────────────────────────────────────────────────────

function Header({ summary, historyTier }: { summary: SpendSummary; historyTier: RecommendationResult['historyTier'] }) {
  const topTwo = summary.topCategories.slice(0, 2);
  const subtitle = topTwo.length > 0
    ? `Based on ${summary.transactionCount} checkout${summary.transactionCount !== 1 ? 's' : ''} · ${topTwo.map(t => CAT_LABELS[t.category] ?? t.category).join(', ')} are your top categories`
    : `Based on ${summary.transactionCount} checkout${summary.transactionCount !== 1 ? 's' : ''}`;

  return (
    <div className="px-4 pt-3.5 pb-3">
      <div className="flex items-center justify-between">
        <p className="text-sm font-semibold text-gray-900">Cards for you</p>
        {historyTier === 'limited' && (
          <span className="text-[10px] px-2 py-0.5 rounded-full bg-amber-50 text-amber-600 font-medium">
            Limited history
          </span>
        )}
      </div>
      <p className="text-[11px] text-gray-400 mt-0.5 leading-relaxed">{subtitle}</p>
    </div>
  );
}

// ─── Recommendation card ──────────────────────────────────────────────────────

function RecommendationCard({
  rec,
  isFirst,
  historyTier,
}: {
  rec: CardRecommendation;
  isFirst: boolean;
  historyTier: RecommendationResult['historyTier'];
}) {
  const { card, tier, deltaMonthly, paybackMonths, topReasons } = rec;
  const meta = TIER_META[tier];
  const hasAnnualFee = card.annualFee > 0;
  const hasLearnMore = !!card.sourceUrl;

  return (
    <div className="px-4 py-3">
      {/* Tier label */}
      <p className={`text-[10px] font-semibold uppercase tracking-wider mb-2 ${meta.accent ? 'text-[#1D9E75]' : 'text-gray-400'}`}>
        {meta.label}
      </p>

      <div className={`rounded-xl p-3.5 ${isFirst ? 'border border-[#1D9E75]/20 bg-[#1D9E75]/[0.03]' : 'border border-gray-100 bg-gray-50/50'}`}>
        {/* Card header */}
        <div className="flex items-start justify-between gap-3">
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-0.5">
              <p className="text-sm font-semibold text-gray-900 truncate">{card.name}</p>
              <CardInfoTooltip catalog={card} />
            </div>
            <p className="text-[11px] text-gray-400 mt-0.5">
              {card.issuer} · {card.network.toUpperCase()}
            </p>
          </div>

          {/* Monthly delta — the headline number */}
          <div className="text-right shrink-0">
            <p className="text-lg font-bold text-[#1D9E75] leading-tight">
              +${deltaMonthly.toFixed(2)}
              <span className="text-xs font-normal text-[#1D9E75]/70">/mo</span>
            </p>
            <p className="text-[10px] text-gray-400">more than now</p>
          </div>
        </div>

        {/* Top 2 reasons */}
        {topReasons.length > 0 && (
          <div className="mt-2.5 space-y-1">
            {topReasons.map(({ category, rate, monthlyGain }) => (
              <div key={category} className="flex items-center gap-1.5">
                <span className="text-[10px] text-[#1D9E75]">✓</span>
                <p className="text-[11px] text-gray-600">
                  <span className="font-medium">{rate}x {CAT_LABELS[category] ?? category.toLowerCase()}</span>
                  {' '}— your {topReasonsRank(category, monthlyGain)} spend category
                  {' '}
                  <span className="text-gray-400">(+${monthlyGain.toFixed(2)}/mo)</span>
                </p>
              </div>
            ))}
          </div>
        )}

        {/* Fee payback or no annual fee */}
        <div className={`mt-2.5 rounded-lg px-2.5 py-1.5 text-[11px] ${
          hasAnnualFee ? 'bg-amber-50 text-amber-700' : 'bg-gray-100 text-gray-500'
        }`}>
          {hasAnnualFee && paybackMonths !== null
            ? `$${card.annualFee} annual fee · paid back in ${paybackMonths.toFixed(1)} months at your spend level`
            : 'No annual fee'
          }
        </div>

        {/* Learn more */}
        {hasLearnMore && (
          <a
            href={card.sourceUrl}
            target="_blank"
            rel="noreferrer"
            className="mt-2 block text-right text-[11px] text-[#1D9E75] hover:underline"
          >
            Learn more →
          </a>
        )}
      </div>
    </div>
  );
}

// ─── Empty / guard states ─────────────────────────────────────────────────────

function TooFewCheckouts({ count }: { count: number }) {
  return (
    <div className="px-6 py-8 text-center">
      <p className="text-3xl mb-3">🛒</p>
      <p className="text-sm font-semibold text-gray-800 mb-1">
        Shop on a few more checkouts
      </p>
      <p className="text-xs text-gray-500 leading-relaxed">
        Milkr needs at least 3 checkouts to understand your spending.
        You've done {count} — just {3 - count} more to go.
      </p>
    </div>
  );
}

function NoRecommendations() {
  return (
    <div className="px-6 py-8 text-center">
      <p className="text-3xl mb-3">🐄</p>
      <p className="text-sm font-semibold text-gray-800 mb-1">
        You've already got a great wallet
      </p>
      <p className="text-xs text-gray-500 leading-relaxed">
        Based on your spending, your current cards are earning near-maximum rewards.
        Check back as your spending patterns change.
      </p>
    </div>
  );
}

// ─── Loading + error ──────────────────────────────────────────────────────────

function LoadingSkeleton() {
  return (
    <div className="px-4 py-4 space-y-3">
      <div className="h-4 w-32 bg-gray-100 rounded animate-pulse" />
      <div className="h-3 w-48 bg-gray-50 rounded animate-pulse" />
      <div className="h-24 w-full bg-gray-50 rounded-xl animate-pulse mt-3" />
      <div className="h-24 w-full bg-gray-50 rounded-xl animate-pulse" />
    </div>
  );
}

function ErrorState({ msg, onRetry }: { msg: string; onRetry: () => void }) {
  return (
    <div className="px-4 py-6 text-center space-y-2">
      <p className="text-xs text-gray-500 leading-relaxed">{msg}</p>
      <button onClick={onRetry} className="text-xs text-[#1D9E75] underline">
        Retry
      </button>
    </div>
  );
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Returns a rank label ("top", "2nd", "3rd") for a category based on monthly gain.
 * Used in the reason string: "4x groceries — your top spend category"
 */
function topReasonsRank(_category: string, monthlyGain: number): string {
  // Simple heuristic: higher gain = more important to the user
  if (monthlyGain >= 5)  return 'top';
  if (monthlyGain >= 2)  return 'high';
  return 'regular';
}
