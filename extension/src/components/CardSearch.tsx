import { useEffect, useRef, useState } from 'react';
import type { CatalogCard, RedemptionPreference } from '@/types';
import { walletStorage } from '@/lib/storage';
import { getRedemptionOptions, isPointsCard } from '@/lib/redemption';
import { searchCards, enrichCard, type SearchHit } from '@/entrypoints/popup/api';
import CardInfoTooltip from '@/components/CardInfoTooltip';

// ─── CardSearch ───────────────────────────────────────────────────────────────
// Standalone search + auto-enrichment widget used inside WalletSetup.
// State machine:
//   idle → results → enriching → preview → confirming → saved
//                              ↘ error

interface CardSearchProps {
  initialQuery?: string;
  /** Called after the card is confirmed and saved to WalletStorage. */
  onCardAdded: (card: CatalogCard, redemption: RedemptionPreference) => void;
  onDismiss?: () => void;
}

type Phase =
  | { tag: 'idle' }
  | { tag: 'results'; hits: SearchHit[]; query: string }
  | { tag: 'enriching'; query: string; step: string }
  | { tag: 'preview'; result: { card: CatalogCard; confidence: number; source: string } }
  | { tag: 'confirming'; card: CatalogCard; redemption: RedemptionPreference }
  | { tag: 'saving' }
  | { tag: 'error'; msg: string };

export default function CardSearch({ initialQuery = '', onCardAdded, onDismiss }: CardSearchProps) {
  const [query, setQuery]   = useState(initialQuery);
  const [phase, setPhase]   = useState<Phase>({ tag: 'idle' });
  const debounceRef         = useRef<ReturnType<typeof setTimeout> | null>(null);
  const enrichTimerRef      = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Debounced search — fires 300ms after the user stops typing
  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    if (query.length < 2) { setPhase({ tag: 'idle' }); return; }

    debounceRef.current = setTimeout(async () => {
      try {
        const hits = await searchCards(query);
        setPhase({ tag: 'results', hits, query });
      } catch {
        setPhase({ tag: 'idle' });
      }
    }, 300);

    return () => { if (debounceRef.current) clearTimeout(debounceRef.current); };
  }, [query]);

  async function startEnrich(q: string) {
    // Show step-by-step loading messages
    const steps = [
      'Searching for card...',
      'Found issuer page...',
      'Extracting reward rates...',
    ];
    let stepIdx = 0;
    setPhase({ tag: 'enriching', query: q, step: steps[0] });

    enrichTimerRef.current = setInterval(() => {
      stepIdx = Math.min(stepIdx + 1, steps.length - 1);
      setPhase((prev) =>
        prev.tag === 'enriching' ? { ...prev, step: steps[stepIdx] } : prev
      );
    }, 2500);

    // 15-second timeout
    const timeout = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("Couldn't find that card — try a different name or add manually")), 15_000)
    );

    try {
      const result = await Promise.race([enrichCard(q), timeout]);
      clearInterval(enrichTimerRef.current!);
      setPhase({ tag: 'preview', result });
    } catch (e) {
      clearInterval(enrichTimerRef.current!);
      setPhase({ tag: 'error', msg: e instanceof Error ? e.message : String(e) });
    }
  }

  function confirmCard(card: CatalogCard) {
    const opts = getRedemptionOptions(card);
    setPhase({ tag: 'confirming', card, redemption: opts[0].value });
  }

  async function saveCard(card: CatalogCard, redemption: RedemptionPreference) {
    setPhase({ tag: 'saving' });
    const wallet = await walletStorage.getValue();
    // Prevent duplicates by catalogId
    if (!wallet.some((w) => w.catalogId === card.id)) {
      await walletStorage.setValue([
        ...wallet,
        {
          id: crypto.randomUUID(),
          catalogId: card.id,
          cardType: card.cardType,
          redemptionPreference: redemption,
          periodSpend: {},
          addedAt: new Date().toISOString(),
        },
      ]);
    }
    onCardAdded(card, redemption);
  }

  // ── Render ──────────────────────────────────────────────────────────────────

  return (
    <div className="px-4 py-3 border-b border-gray-100">
      {/* Input */}
      <div className="flex items-center gap-2">
        <div className="flex-1 relative">
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search cards (e.g. Chase Sapphire)"
            className="w-full text-sm px-3 py-2 rounded-lg border border-gray-200 outline-none focus:border-[#1D9E75] transition-colors placeholder:text-gray-400"
            autoFocus={!!initialQuery}
          />
          {query && (
            <button
              onClick={() => { setQuery(''); setPhase({ tag: 'idle' }); }}
              className="absolute right-2.5 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600 text-xs"
            >
              ✕
            </button>
          )}
        </div>
        {onDismiss && (
          <button onClick={onDismiss} className="text-xs text-gray-400 hover:text-gray-600 shrink-0">
            Cancel
          </button>
        )}
      </div>

      {/* Too-generic query hint */}
      {query.length >= 2 && /^(visa|mastercard|amex|discover|credit card)$/i.test(query.trim()) && (
        <p className="text-[11px] text-amber-600 mt-1.5">
          Try being more specific — e.g. "Chase Freedom Visa"
        </p>
      )}

      {/* Results dropdown */}
      {phase.tag === 'results' && (
        <div className="mt-2 rounded-xl border border-gray-100 overflow-hidden shadow-sm">
          {phase.hits.length > 0 && (
            <div>
              {phase.hits.map(({ card, score }) => (
                <button
                  key={card.id}
                  onClick={() => confirmCard(card)}
                  className="w-full flex items-center gap-3 px-3 py-2.5 text-left hover:bg-gray-50 transition-colors border-b border-gray-50 last:border-0"
                >
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-0.5">
                      <p className="text-sm font-medium text-gray-800 truncate">{card.name}</p>
                      <CardInfoTooltip catalog={card} />
                    </div>
                    <p className="text-[11px] text-gray-400">
                      {card.issuer} · {card.network.toUpperCase()} · {topRateSummary(card)}
                    </p>
                  </div>
                  <span className="text-[10px] text-gray-300 shrink-0">{score.toFixed(0)}%</span>
                </button>
              ))}
            </div>
          )}

          {/* Auto-enrich option — shown when query is specific enough */}
          {phase.query.length >= 3 && (
            <button
              onClick={() => startEnrich(phase.query)}
              className="w-full flex items-center gap-2 px-3 py-2.5 text-left hover:bg-[#1D9E75]/[0.04] transition-colors"
            >
              <span className="text-sm">🔍</span>
              <p className="text-sm text-[#1D9E75] font-medium">
                Look up "{phase.query}" automatically
              </p>
            </button>
          )}
        </div>
      )}

      {/* Enriching — step-by-step loading */}
      {phase.tag === 'enriching' && (
        <div className="mt-3 flex items-center gap-2 text-gray-500">
          <svg className="animate-spin w-3.5 h-3.5 shrink-0" viewBox="0 0 24 24" fill="none">
            <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" className="opacity-20" />
            <path d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z" fill="currentColor" className="opacity-75" />
          </svg>
          <p className="text-xs">{phase.step}</p>
        </div>
      )}

      {/* Preview */}
      {phase.tag === 'preview' && (
        <CardPreview
          result={phase.result}
          onConfirm={confirmCard}
          onBack={() => setPhase({ tag: 'results', hits: [], query })}
        />
      )}

      {/* Redemption preference selection */}
      {phase.tag === 'confirming' && (
        <RedemptionPicker
          card={phase.card}
          redemption={phase.redemption}
          onRedemptionChange={(r) => setPhase({ ...phase, redemption: r })}
          onSave={() => saveCard(phase.card, phase.redemption)}
          onBack={() => confirmCard(phase.card)}
        />
      )}

      {/* Saving */}
      {phase.tag === 'saving' && (
        <div className="mt-3 text-xs text-gray-400 text-center">Saving…</div>
      )}

      {/* Error */}
      {phase.tag === 'error' && (
        <div className="mt-2 rounded-lg bg-red-50 px-3 py-2 flex items-start gap-2">
          <p className="text-xs text-red-600 flex-1 leading-relaxed">{phase.msg}</p>
          <button
            onClick={() => setPhase({ tag: 'idle' })}
            className="text-[10px] text-red-400 shrink-0 underline"
          >
            Dismiss
          </button>
        </div>
      )}
    </div>
  );
}

// ─── Card preview ─────────────────────────────────────────────────────────────

function CardPreview({
  result,
  onConfirm,
  onBack,
}: {
  result: { card: CatalogCard; confidence: number; source: string };
  onConfirm: (card: CatalogCard) => void;
  onBack: () => void;
}) {
  const { card, confidence, source } = result;
  const topRates = getTopRates(card);

  return (
    <div className="mt-2 rounded-xl border border-gray-100 overflow-hidden">
      <div className="px-3 py-2.5 bg-gray-50 border-b border-gray-100">
        <div className="flex items-start justify-between gap-2">
          <div>
            <p className="text-sm font-semibold text-gray-900">{card.name}</p>
            <p className="text-[11px] text-gray-500 mt-0.5">
              {card.issuer} · {card.network.toUpperCase()} · {card.annualFee > 0 ? `$${card.annualFee}/yr` : 'No annual fee'}
            </p>
          </div>
          <ConfidenceBadge confidence={confidence} source={source} />
        </div>

        {/* Top 3 reward rates */}
        <div className="flex flex-wrap gap-1.5 mt-2">
          {topRates.map(([cat, rate]) => (
            <span key={cat} className="text-[10px] px-1.5 py-0.5 bg-white border border-gray-200 rounded font-medium text-gray-700">
              {rate}x {cat}
            </span>
          ))}
        </div>

        {/* Low confidence warning */}
        {confidence < 0.7 && (
          <p className="text-[11px] text-amber-600 mt-2">
            ⚠ Some rates couldn't be verified — you can edit them after adding
          </p>
        )}
      </div>

      <div className="flex items-center gap-2 px-3 py-2">
        <button onClick={onBack} className="text-xs text-gray-400 hover:text-gray-600">
          ← Back
        </button>
        <button
          onClick={() => onConfirm(card)}
          className="flex-1 py-1.5 rounded-lg text-xs font-semibold bg-[#1D9E75] text-white hover:bg-[#189060] transition-colors"
        >
          Add this card
        </button>
      </div>
    </div>
  );
}

// ─── Redemption picker ────────────────────────────────────────────────────────

function RedemptionPicker({
  card,
  redemption,
  onRedemptionChange,
  onSave,
  onBack,
}: {
  card: CatalogCard;
  redemption: RedemptionPreference;
  onRedemptionChange: (r: RedemptionPreference) => void;
  onSave: () => void;
  onBack: () => void;
}) {
  const options = getRedemptionOptions(card);
  const selected = options.find((o) => o.value === redemption) ?? options[0];

  return (
    <div className="mt-2 rounded-xl border border-gray-100 overflow-hidden">
      <div className="px-3 py-2.5 border-b border-gray-100">
        <p className="text-xs font-semibold text-gray-700">
          How do you redeem {card.name} rewards?
        </p>

        {/* Only show selector if there are multiple options (points/miles cards) */}
        {options.length > 1 && (
          <div className="flex gap-1.5 mt-2">
            {options.map((opt) => (
              <button
                key={opt.value}
                onClick={() => onRedemptionChange(opt.value)}
                className={`flex-1 text-[11px] py-1.5 rounded-lg font-medium transition-colors ${
                  redemption === opt.value
                    ? 'bg-[#1D9E75] text-white'
                    : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
                }`}
              >
                {opt.label}
              </button>
            ))}
          </div>
        )}

        {/* Card-aware explanation for the selected option */}
        <p className="text-[11px] text-gray-500 mt-2 leading-relaxed">
          {selected.explanation}
        </p>
      </div>

      <div className="flex items-center gap-2 px-3 py-2">
        <button onClick={onBack} className="text-xs text-gray-400 hover:text-gray-600">
          ← Back
        </button>
        <button
          onClick={onSave}
          className="flex-1 py-1.5 rounded-lg text-xs font-semibold bg-[#1D9E75] text-white hover:bg-[#189060] transition-colors"
        >
          Save to wallet
        </button>
      </div>
    </div>
  );
}

// ─── Confidence badge ─────────────────────────────────────────────────────────

function ConfidenceBadge({ confidence, source }: { confidence: number; source: string }) {
  if (source === 'catalog') return (
    <span className="text-[10px] px-1.5 py-0.5 rounded bg-[#1D9E75]/10 text-[#1D9E75] font-medium shrink-0">
      Verified
    </span>
  );
  if (confidence >= 0.85) return (
    <span className="text-[10px] px-1.5 py-0.5 rounded bg-green-50 text-green-700 font-medium shrink-0">
      High confidence
    </span>
  );
  if (confidence >= 0.7) return (
    <span className="text-[10px] px-1.5 py-0.5 rounded bg-yellow-50 text-yellow-700 font-medium shrink-0">
      ~{Math.round(confidence * 100)}% confident
    </span>
  );
  return (
    <span className="text-[10px] px-1.5 py-0.5 rounded bg-red-50 text-red-600 font-medium shrink-0">
      Low confidence
    </span>
  );
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Top 3 non-base reward rates for the preview chips. */
function getTopRates(card: CatalogCard): [string, number][] {
  const cats: [string, number][] = [
    ['dining', card.rewardRates.dining],
    ['groceries', card.rewardRates.groceries],
    ['travel', card.rewardRates.travel],
    ['gas', card.rewardRates.gas],
    ['streaming', card.rewardRates.streaming],
    ['drugstore', card.rewardRates.drugstore],
    ['transit', card.rewardRates.transit],
    ['shopping', card.rewardRates.ecommerce],
  ];
  return cats
    .filter(([, r]) => r > card.rewardRates.other)
    .sort(([, a], [, b]) => b - a)
    .slice(0, 3);
}

/** Compact "Xx dining · Yx travel" for the results dropdown subtitle. */
function topRateSummary(card: CatalogCard): string {
  const top = getTopRates(card);
  if (!top.length) return `${card.rewardRates.other}x everywhere`;
  return top.map(([cat, r]) => `${r}x ${cat}`).join(' · ');
}
