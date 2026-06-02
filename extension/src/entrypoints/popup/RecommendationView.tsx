import { useEffect, useState } from 'react';
import type { BNPLOption, MerchantContext, RankedCard, Recommendation } from '@/types';
import { historyDB } from '@/lib/storage';
import WhyPanel from '@/components/WhyPanel';
import CardInfoTooltip from '@/components/CardInfoTooltip';

// ─── Display maps ─────────────────────────────────────────────────────────────

const CATEGORY_LABELS: Record<string, string> = {
  DINING: 'Dining', GROCERIES: 'Groceries', TRAVEL: 'Travel', GAS: 'Gas',
  ECOMMERCE: 'Shopping', ENTERTAINMENT: 'Entertainment', STREAMING: 'Streaming',
  DRUGSTORE: 'Drugstore', TRANSIT: 'Transit', OTHER: 'Other',
};

// Where to activate rotating categories, keyed by issuer name
const ACTIVATION_URLS: Record<string, string> = {
  Chase: 'https://chasebonus.com',
  Discover: 'https://www.discover.com/credit-cards/cashback-bonus',
};

const NETWORK_CHIP: Record<string, string> = {
  visa: 'bg-blue-50 text-blue-600',
  mastercard: 'bg-orange-50 text-orange-600',
  amex: 'bg-sky-50 text-sky-600',
  discover: 'bg-orange-50 text-orange-600',
};

// ─── Root ─────────────────────────────────────────────────────────────────────

export default function RecommendationView({
  rec,
  onManageWallet,
  onShowOnboarding,
  onShowForYou,
}: {
  rec: Recommendation;
  onManageWallet: () => void;
  onShowOnboarding: () => void;
  onShowForYou?: () => void;
}) {
  const ctx = rec.merchantContext;
  const best = rec.ranked[0];

  // Running total of expected value saved — read from IndexedDB after each render.
  // App.tsx saves the current recommendation before mounting this component,
  // so the total already includes today's checkout.
  const [totalSaved,   setTotalSaved]   = useState<number>(0);
  const [historyCount, setHistoryCount] = useState<number>(0);
  useEffect(() => {
    historyDB.totalSaved().then(setTotalSaved);
    historyDB.recent(10).then(e => setHistoryCount(e.length));
  }, [rec]);
  const rest = rec.ranked.slice(1);
  const noCards = rec.ranked.length === 0;

  return (
    <div className="w-[380px] bg-white select-none">
      {/* ── Header ── */}
      <div className="flex items-center justify-between px-4 py-2.5 border-b border-gray-100">
        <div className="flex items-center gap-2 min-w-0">
          <span className="font-bold text-[#1D9E75] text-sm tracking-tight shrink-0">milkr</span>
          <span className="text-gray-200">·</span>
          <span className="text-sm font-medium text-gray-800 truncate">{ctx.merchantName}</span>
        </div>
        <div className="flex items-center gap-2 shrink-0 ml-2">
          {ctx.transactionAmount != null && (
            <span className="text-sm font-semibold text-gray-700">
              ${ctx.transactionAmount.toFixed(2)}
            </span>
          )}
          <span className="text-[11px] px-2 py-0.5 rounded-full bg-gray-100 text-gray-500 font-medium">
            {CATEGORY_LABELS[ctx.category] ?? ctx.category}
          </span>
        </div>
      </div>

      <div className="divide-y divide-gray-100">
        {noCards ? (
          <NoCardsState onManageWallet={onManageWallet} />
        ) : (
          <>
            {best && <BestCardSection card={best} ranked={rec.ranked} merchantContext={ctx} />}

            {rest.length > 0 && (
              <div className="px-4 py-3">
                <SectionLabel>Your other cards</SectionLabel>
                <div className="space-y-2.5 mt-2">
                  {rest.map((card, i) => (
                    <RankedRow key={card.wallet.id} rank={i + 2} card={card} />
                  ))}
                </div>
              </div>
            )}
          </>
        )}

        {rec.bnplOptions.length > 0 && <BNPLSection options={rec.bnplOptions} />}

        {rec.giftCardTip && (
          <div className="px-4 py-3 flex gap-2.5 items-start">
            <span className="text-sm shrink-0 mt-px">💡</span>
            <p className="text-xs text-amber-700 leading-relaxed">{rec.giftCardTip}</p>
          </div>
        )}

        {ctx.contextDependent && (
          <div className="px-4 py-2 bg-amber-50">
            <p className="text-[11px] text-amber-600">
              ⚠ Reward category may vary by transaction type at this merchant
            </p>
          </div>
        )}

        {/* 5th-checkout prompt — surfaces the For You tab once there's enough history */}
        {historyCount >= 5 && onShowForYou && (
          <div className="px-4 py-2 border-t border-gray-50">
            <button
              onClick={onShowForYou}
              className="text-[11px] text-[#1D9E75] hover:underline transition-colors"
            >
              See cards that could earn you more →
            </button>
          </div>
        )}

        {/* Footer */}
        <div className="px-4 py-2 flex items-center justify-between">
          <div className="flex items-center gap-1.5">
            <span className="text-[10px] text-gray-300 font-semibold tracking-widest uppercase">
              milkr
            </span>
            {totalSaved > 0 && (
              <span className="text-[10px] text-[#1D9E75] font-medium">
                · ${totalSaved.toFixed(2)} saved
              </span>
            )}
          </div>
          <div className="flex items-center gap-2.5">
            <button
              onClick={onShowOnboarding}
              className="text-[11px] text-gray-300 hover:text-gray-500 transition-colors"
            >
              how it works
            </button>
            <button
              onClick={onManageWallet}
              className="text-[11px] text-gray-400 hover:text-gray-600 transition-colors"
            >
              Manage wallet
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── Best card ────────────────────────────────────────────────────────────────

function BestCardSection({
  card,
  ranked,
  merchantContext,
}: {
  card: RankedCard;
  ranked: RankedCard[];
  merchantContext: MerchantContext;
}) {
  const { catalog, resolved } = card;
  const activationUrl = ACTIVATION_URLS[catalog.issuer];
  const daysLeft = resolved.overrideExpires ? daysUntil(resolved.overrideExpires) : null;
  const expiringSoon = daysLeft !== null && daysLeft <= 7;
  const [isExpanded, setIsExpanded] = useState(false);

  return (
    <div className="px-4 py-3">
      <SectionLabel accent>✦ Best choice</SectionLabel>

      <div className="mt-2 rounded-xl border border-[#1D9E75]/25 bg-[#1D9E75]/[0.03] p-3.5">
        {/* Card name + rate */}
        <div className="flex items-start gap-3">
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-0.5">
              <p className="font-semibold text-gray-900 text-sm leading-snug">{catalog.name}</p>
              <CardInfoTooltip catalog={catalog} wallet={card.wallet} />
            </div>
            <p className="text-xs text-gray-500 mt-0.5 leading-relaxed">{resolved.rationale}</p>
          </div>
          <div className="text-right shrink-0">
            <p className="text-xl font-bold text-[#1D9E75] leading-none">
              {fmtRate(resolved.rate)}x
            </p>
            {resolved.expectedValue > 0 && (
              <p className="text-[11px] text-gray-400 mt-0.5">
                +${resolved.expectedValue.toFixed(2)}
              </p>
            )}
          </div>
        </div>

        {/* Chips */}
        <div className="flex flex-wrap gap-1.5 mt-2.5">
          <Chip className={catalog.cardType === 'credit' ? 'bg-violet-50 text-violet-600' : 'bg-teal-50 text-teal-600'}>
            {catalog.cardType}
          </Chip>
          <Chip className={NETWORK_CHIP[catalog.network] ?? 'bg-gray-100 text-gray-500'}>
            {catalog.network}
          </Chip>
          {resolved.isRotating && <Chip className="bg-purple-50 text-purple-600">rotating</Chip>}
          {resolved.isBlended && <Chip className="bg-yellow-50 text-yellow-600">cap near</Chip>}
          {resolved.confidence < 0.8 && <Chip className="bg-red-50 text-red-500">stale data</Chip>}
        </div>

        {/* Activation notice — rotating cards (Freedom Flex, Discover It) require opt-in */}
        {resolved.requiresActivation && (
          <div className="mt-2.5 flex items-start gap-1.5 bg-amber-50 rounded-lg px-2.5 py-2">
            <span className="text-xs shrink-0">⚡</span>
            <p className="text-[11px] text-amber-700 leading-snug">
              Activate quarterly bonus before using
              {activationUrl && (
                <>
                  {' — '}
                  <a
                    href={activationUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="underline font-medium"
                  >
                    {new URL(activationUrl).hostname.replace('www.', '')}
                  </a>
                </>
              )}
            </p>
          </div>
        )}

        {/* Expiry notice when override is about to end */}
        {expiringSoon && resolved.overrideExpires && (
          <div className="mt-2 bg-orange-50 rounded-lg px-2.5 py-2">
            <p className="text-[11px] text-orange-600">
              Offer expires {resolved.overrideExpires} · {daysLeft}d left
            </p>
          </div>
        )}

        {/* Why button — only shown when there's something to compare */}
        {ranked.length > 0 && (
          <button
            onClick={() => setIsExpanded((v) => !v)}
            className="mt-3 flex items-center gap-1 text-[11px] text-[#1D9E75] hover:text-[#189060] font-medium transition-colors"
          >
            <span>{isExpanded ? '▲ Hide breakdown' : '▼ Why this card?'}</span>
          </button>
        )}

        {/* Accordion — CSS max-height transition, no layout shift */}
        <div
          style={{
            maxHeight: isExpanded ? '600px' : '0',
            overflow: 'hidden',
            transition: 'max-height 200ms ease',
          }}
        >
          <WhyPanel ranked={ranked} merchantContext={merchantContext} />
        </div>
      </div>
    </div>
  );
}

// ─── Ranked row ───────────────────────────────────────────────────────────────

function RankedRow({ rank, card }: { rank: number; card: RankedCard }) {
  const { catalog, resolved } = card;
  return (
    <div className="flex items-center gap-3">
      <span className="text-xs text-gray-300 w-4 text-right shrink-0">{rank}</span>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-0.5">
          <p className="text-sm text-gray-700 truncate">{catalog.name}</p>
          <CardInfoTooltip catalog={catalog} wallet={card.wallet} />
        </div>
        {resolved.requiresActivation && (
          <p className="text-[10px] text-amber-500">⚡ needs activation</p>
        )}
      </div>
      <div className="text-right shrink-0">
        <p className="text-sm font-medium text-gray-600">{fmtRate(resolved.rate)}x</p>
        {resolved.expectedValue > 0 && (
          <p className="text-[10px] text-gray-400">+${resolved.expectedValue.toFixed(2)}</p>
        )}
      </div>
    </div>
  );
}

// ─── BNPL ─────────────────────────────────────────────────────────────────────

function BNPLSection({ options }: { options: BNPLOption[] }) {
  return (
    <div className="px-4 py-3">
      <SectionLabel>Pay later</SectionLabel>
      <div className="flex gap-2 flex-wrap mt-2">
        {options.map((opt) => (
          <div
            key={opt.provider}
            className="flex items-center gap-1 text-xs bg-blue-50 text-blue-700 px-2.5 py-1.5 rounded-lg font-medium capitalize"
          >
            {opt.provider}
            {opt.installmentAmount != null && (
              <span className="text-blue-400 font-normal">
                · 4 × ${opt.installmentAmount.toFixed(2)}
              </span>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

// ─── Empty state ──────────────────────────────────────────────────────────────

function NoCardsState({ onManageWallet }: { onManageWallet: () => void }) {
  return (
    <div className="px-4 py-6 text-center">
      <p className="text-sm text-gray-500">No cards in your wallet work here.</p>
      <button
        onClick={onManageWallet}
        className="mt-2 text-xs text-[#1D9E75] underline"
      >
        Update wallet
      </button>
    </div>
  );
}

// ─── Shared primitives ────────────────────────────────────────────────────────

function SectionLabel({ children, accent }: { children: React.ReactNode; accent?: boolean }) {
  return (
    <p className={`text-[11px] font-semibold uppercase tracking-wider ${accent ? 'text-[#1D9E75]' : 'text-gray-400'}`}>
      {children}
    </p>
  );
}

function Chip({ children, className }: { children: React.ReactNode; className: string }) {
  return (
    <span className={`text-[10px] px-1.5 py-0.5 rounded font-medium ${className}`}>
      {children}
    </span>
  );
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function fmtRate(rate: number): string {
  return rate % 1 === 0 ? rate.toFixed(0) : rate.toFixed(1);
}

function daysUntil(dateStr: string): number {
  return Math.ceil((new Date(dateStr).getTime() - Date.now()) / 86_400_000);
}
