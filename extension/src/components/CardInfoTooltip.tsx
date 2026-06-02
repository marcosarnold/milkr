import { useEffect, useRef, useState } from 'react';
import type { CatalogCard, MerchantCategory, WalletCard } from '@/types';
import { spendDB } from '@/lib/storage';
import { fetchOverrides, type OverrideEntry } from '@/entrypoints/popup/api';

// ─── CardInfoTooltip ──────────────────────────────────────────────────────────
// Self-contained ⓘ button + tooltip. Fetches its own override and spend data
// lazily on first open — parents just pass the CatalogCard.
//
// Hover opens on desktop; click toggles on touch. Tap outside or Escape closes.
// Tooltip is position:fixed to escape any overflow:hidden ancestors inside the popup.

// ─── Category display config ──────────────────────────────────────────────────

const CAT_META: { key: keyof import('@/types').RewardRates; upper: MerchantCategory | 'other'; label: string; icon: string }[] = [
  { key: 'dining',        upper: 'DINING',        label: 'Dining',        icon: '🍽'  },
  { key: 'groceries',     upper: 'GROCERIES',     label: 'Groceries',     icon: '🛒'  },
  { key: 'travel',        upper: 'TRAVEL',        label: 'Travel',        icon: '✈️'  },
  { key: 'gas',           upper: 'GAS',           label: 'Gas',           icon: '⛽'  },
  { key: 'ecommerce',     upper: 'ECOMMERCE',     label: 'Shopping',      icon: '🛍'  },
  { key: 'entertainment', upper: 'ENTERTAINMENT', label: 'Entertainment', icon: '🎭'  },
  { key: 'streaming',     upper: 'STREAMING',     label: 'Streaming',     icon: '📺'  },
  { key: 'drugstore',     upper: 'DRUGSTORE',     label: 'Drugstore',     icon: '💊'  },
  { key: 'transit',       upper: 'TRANSIT',       label: 'Transit',       icon: '🚇'  },
];

// Where to activate rotating bonuses — same lookup used in RecommendationView
const ACTIVATION_URLS: Record<string, string> = {
  Chase:    'https://chasebonus.com',
  Discover: 'https://www.discover.com/credit-cards/cashback-bonus',
};

const REWARD_LABELS: Record<string, string> = {
  cashback: 'Cashback',
  points:   'Points',
  miles:    'Miles',
  flex:     'Flex',
};

const CAP_LABELS: Record<string, string> = {
  DINING: 'Dining', GROCERIES: 'Grocery', TRAVEL: 'Travel',
  GAS: 'Gas', ECOMMERCE: 'Shopping', ENTERTAINMENT: 'Entertainment',
  STREAMING: 'Streaming', DRUGSTORE: 'Drugstore', TRANSIT: 'Transit', OTHER: 'Other',
};

// ─── Types ────────────────────────────────────────────────────────────────────

interface TooltipData {
  activeOverrides: { category: string; entry: OverrideEntry }[];
  capSpends: Map<string, number>;
}

interface CardInfoTooltipProps {
  catalog: CatalogCard;
  wallet?: WalletCard;
  position?: 'top' | 'bottom' | 'auto';
}

// ─── Component ────────────────────────────────────────────────────────────────

export default function CardInfoTooltip({ catalog, wallet, position = 'auto' }: CardInfoTooltipProps) {
  const triggerRef = useRef<HTMLButtonElement>(null);
  const tooltipRef = useRef<HTMLDivElement>(null);

  const [isOpen,   setIsOpen]   = useState(false);
  const [visible,  setVisible]  = useState(false);    // drives CSS transition
  const [side,     setSide]     = useState<'top' | 'bottom'>('bottom');
  const [pos,      setPos]      = useState({ x: 0, y: 0 });
  const [data,     setData]     = useState<TooltipData | null>(null);
  const [loading,  setLoading]  = useState(false);

  // Delayed close — lets mouse travel from trigger → tooltip without flicker
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  function cancelClose() {
    if (closeTimer.current) { clearTimeout(closeTimer.current); closeTimer.current = null; }
  }

  function scheduleClose(delay = 80) {
    cancelClose();
    closeTimer.current = setTimeout(() => {
      setVisible(false);
      setTimeout(() => setIsOpen(false), 150);
    }, delay);
  }

  // ── Position calculation ──────────────────────────────────────────────────

  function computePosition() {
    if (!triggerRef.current) return;
    const rect = triggerRef.current.getBoundingClientRect();
    const TOOLTIP_W = 272;
    const TOOLTIP_H = 300; // conservative estimate
    const GAP       = 6;

    const computedSide: 'top' | 'bottom' =
      position !== 'auto'
        ? position
        : window.innerHeight - rect.bottom >= TOOLTIP_H + GAP
        ? 'bottom'
        : 'top';

    setSide(computedSide);
    setPos({
      x: Math.max(8, Math.min(rect.left - 4, window.innerWidth - TOOLTIP_W - 8)),
      y: computedSide === 'bottom' ? rect.bottom + GAP : rect.top - GAP,
    });
  }

  // ── Open / close ──────────────────────────────────────────────────────────

  function open() {
    cancelClose();
    computePosition();
    setIsOpen(true);
    requestAnimationFrame(() => setVisible(true)); // next frame → triggers CSS transition
    if (!data && !loading) fetchData();
  }

  function close() {
    scheduleClose(0);
  }

  function toggle() {
    if (isOpen) close(); else open();
  }

  // ── Click outside / Escape ────────────────────────────────────────────────

  useEffect(() => {
    if (!isOpen) return;
    function onDown(e: MouseEvent) {
      if (!triggerRef.current?.contains(e.target as Node) &&
          !tooltipRef.current?.contains(e.target as Node)) {
        close();
      }
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') close();
    }
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [isOpen]);

  // ── Data fetching — lazy, cached in component state ───────────────────────

  async function fetchData() {
    setLoading(true);
    try {
      const today = new Date().toISOString().split('T')[0];

      // All overrides → filter to this card's active ones
      const allOverrides = await fetchOverrides();
      const activeOverrides: TooltipData['activeOverrides'] = [];
      for (const [key, entry] of allOverrides.entries()) {
        if (!key.startsWith(`${catalog.id}:`)) continue;
        if (entry.startDate <= today && entry.endDate >= today) {
          activeOverrides.push({ category: key.split(':')[1], entry });
        }
      }

      // Spend for every capped category — only if wallet card provided
      const capSpends = new Map<string, number>();
      if (wallet) {
        for (const cat of Object.keys(catalog.annualCaps)) {
          capSpends.set(cat, await spendDB.getSpend(catalog.id, cat));
        }
      }

      setData({ activeOverrides, capSpends });
    } catch {
      setData({ activeOverrides: [], capSpends: new Map() });
    } finally {
      setLoading(false);
    }
  }

  // ── Derived display data ──────────────────────────────────────────────────

  const bonusRates = CAT_META.filter(c => (catalog.rewardRates[c.key] ?? 1) > 1);
  const hasCaps    = Object.keys(catalog.annualCaps).length > 0;

  return (
    // Inline wrapper so ⓘ sits naturally after any text without breaking layout
    <span className="inline-flex items-center">
      {/* ── Trigger ── */}
      <button
        ref={triggerRef}
        onClick={toggle}
        onMouseEnter={open}
        onMouseLeave={() => scheduleClose()}
        onKeyDown={e => {
          if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); }
        }}
        aria-label={`More info about ${catalog.name}`}
        aria-expanded={isOpen}
        className="ml-1 text-[11px] text-gray-300 hover:text-gray-400 transition-colors leading-none focus:outline-none focus-visible:ring-1 focus-visible:ring-[#1D9E75] rounded"
      >
        ⓘ
      </button>

      {/* ── Tooltip — fixed to viewport so it escapes any overflow:hidden ── */}
      {isOpen && (
        <div
          ref={tooltipRef}
          role="tooltip"
          onMouseEnter={cancelClose}
          onMouseLeave={() => scheduleClose()}
          style={{
            position: 'fixed',
            left: pos.x,
            width: 272,
            zIndex: 9999,
            ...(side === 'bottom'
              ? { top: pos.y }
              : { bottom: window.innerHeight - pos.y }),
          }}
          className={`
            bg-white rounded-xl border border-gray-200 shadow-xl overflow-hidden
            transition-all duration-[150ms] ease-out
            ${visible
              ? 'opacity-100 translate-y-0'
              : side === 'bottom'
              ? 'opacity-0 -translate-y-1'
              : 'opacity-0 translate-y-1'}
          `}
        >
          {/* Arrow pointer */}
          <div
            className={`absolute left-4 w-2.5 h-2.5 bg-white border-gray-200 rotate-45 ${
              side === 'bottom'
                ? '-top-[5px] border-l border-t'
                : '-bottom-[5px] border-r border-b'
            }`}
          />

          {/* Scrollable content sits above the arrow z-layer */}
          <div className="relative z-10 max-h-[320px] overflow-y-auto bg-white rounded-xl divide-y divide-gray-50">

            {/* ── Section 1: Reward rates ── */}
            <Section title="Reward rates">
              <div className="space-y-1">
                {bonusRates.map(({ key, upper, label, icon }) => {
                  const rate = catalog.rewardRates[key]!;
                  const excl = catalog.categoryExclusions.find(e => e.category === upper);
                  const exclNames = excl?.excludedMerchants
                    .map(d => d.replace('.com', '').replace(/\b\w/g, c => c.toUpperCase()))
                    .join(', ');
                  return (
                    <div key={key} className="flex items-start justify-between gap-2">
                      <div className="flex items-start gap-1.5 min-w-0">
                        <span className="text-xs leading-4 shrink-0">{icon}</span>
                        <div className="min-w-0">
                          <span className="text-xs text-gray-700">{label}</span>
                          {excl && (
                            <p className="text-[10px] text-amber-500 leading-tight">
                              ⚠ excl. {exclNames}
                            </p>
                          )}
                        </div>
                      </div>
                      <span className="text-xs font-semibold text-gray-900 shrink-0">{rate}x</span>
                    </div>
                  );
                })}

                {/* Everything else */}
                {bonusRates.length > 0 && (
                  <div className="pt-1 mt-1 border-t border-gray-100 flex items-center justify-between">
                    <span className="text-[11px] text-gray-400">Everything else</span>
                    <span className="text-[11px] text-gray-400">{catalog.rewardRates.other}x</span>
                  </div>
                )}
                {bonusRates.length === 0 && (
                  <div className="flex items-center justify-between">
                    <span className="text-xs text-gray-400">All purchases</span>
                    <span className="text-xs text-gray-500 font-medium">{catalog.rewardRates.other}x</span>
                  </div>
                )}
              </div>
            </Section>

            {/* ── Section 2: Active now (only when there's an active override) ── */}
            {data && data.activeOverrides.length > 0 && (
              <Section title="Active now" accent>
                {data.activeOverrides.map(({ category, entry }) => {
                  const activationUrl = ACTIVATION_URLS[catalog.issuer];
                  return (
                    <div key={category} className="space-y-0.5">
                      <div className="flex items-center gap-1.5">
                        <span className="text-xs">🔄</span>
                        <span className="text-xs font-medium text-gray-800">
                          {entry.rate}x {CAP_LABELS[category] ?? category}
                        </span>
                      </div>
                      <p className="text-[11px] text-gray-500 ml-5 leading-snug">
                        through {entry.endDate}
                        {entry.requiresActivation && (
                          <>
                            {' · '}
                            {activationUrl
                              ? <a href={activationUrl} target="_blank" rel="noreferrer" className="text-[#1D9E75] underline">activate</a>
                              : 'activate first'
                            }
                          </>
                        )}
                      </p>
                    </div>
                  );
                })}
              </Section>
            )}

            {/* ── Section 3: Card details ── */}
            <Section title="Card details">
              <div className="space-y-1">
                <Row label="Annual fee"   value={catalog.annualFee > 0 ? `$${catalog.annualFee}` : 'None'} />
                <Row label="Network"      value={catalog.network.charAt(0).toUpperCase() + catalog.network.slice(1)} />
                <Row
                  label="Reward type"
                  value={`${REWARD_LABELS[catalog.rewardType] ?? catalog.rewardType} (1pt = ${(catalog.pointValue * 100).toFixed(1)}¢)`}
                />
                <Row label="Foreign fee"  value={catalog.foreignTransactionFee ? '3%' : 'None'} />
              </div>
            </Section>

            {/* ── Section 4: Spending caps (only if caps + wallet provided) ── */}
            {hasCaps && wallet && (
              <Section title="Spending caps">
                {Object.entries(catalog.annualCaps).map(([cat, cap]) => {
                  if (!cap) return null;
                  const used      = data?.capSpends.get(cat) ?? 0;
                  const remaining = Math.max(0, cap - used);
                  return (
                    <div key={cat} className="space-y-0.5">
                      <div className="flex items-center gap-1">
                        <span className="text-xs">⚡</span>
                        <span className="text-xs text-gray-700">
                          {CAP_LABELS[cat] ?? cat} bonus capped at ${cap.toLocaleString()}/yr
                        </span>
                      </div>
                      {used > 0 && (
                        <p className="text-[11px] text-gray-400 ml-4">
                          ${used.toLocaleString()} used · ${remaining.toLocaleString()} remaining
                        </p>
                      )}
                    </div>
                  );
                })}
              </Section>
            )}

            {loading && (
              <div className="px-3 py-2 text-[11px] text-gray-400">Loading…</div>
            )}
          </div>
        </div>
      )}
    </span>
  );
}

// ─── Shared tooltip primitives ────────────────────────────────────────────────

function Section({ title, children, accent }: { title: string; children: React.ReactNode; accent?: boolean }) {
  return (
    <div className="px-3 py-2.5 space-y-1.5">
      <p className={`text-[10px] font-semibold uppercase tracking-wider ${accent ? 'text-[#1D9E75]' : 'text-gray-400'}`}>
        {title}
      </p>
      {children}
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="text-[11px] text-gray-500">{label}</span>
      <span className="text-[11px] text-gray-800 font-medium text-right">{value}</span>
    </div>
  );
}
