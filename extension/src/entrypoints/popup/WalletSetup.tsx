import { useState } from 'react';
import type { CatalogCard, RedemptionPreference, WalletCard } from '@/types';
import { walletStorage } from '@/lib/storage';
import { getRedemptionOptions, isPointsCard } from '@/lib/redemption';
import CardSearch from '@/components/CardSearch';

export default function WalletSetup({
  catalog,
  initialSelected = [],
  onSave,
  onCancel,
}: {
  catalog: CatalogCard[];
  initialSelected?: string[];
  onSave: () => void;
  onCancel?: () => void;
}) {
  const isEditing = initialSelected.length > 0;
  const [selected, setSelected] = useState<Set<string>>(new Set(initialSelected));
  const [redemption, setRedemption] = useState<RedemptionPreference>('cash');
  const [saving, setSaving] = useState(false);
  const [showSearch, setShowSearch] = useState(false);

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  }

  async function save() {
    if (!selected.size || saving) return;
    setSaving(true);
    const cards: WalletCard[] = [...selected].map((catalogId) => ({
      id: crypto.randomUUID(),
      catalogId,
      cardType: catalog.find((c) => c.id === catalogId)!.cardType,
      redemptionPreference: redemption,
      periodSpend: {},
      addedAt: new Date().toISOString(),
    }));
    await walletStorage.setValue(cards);
    onSave();
  }

  // Card-aware redemption: pick the first selected points card to drive explanations.
  // If multiple issuers are selected, explanations show for the "primary" one.
  const selectedPointsCard = [...selected]
    .map((id) => catalog.find((c) => c.id === id))
    .find((c) => c && isPointsCard(c)) as CatalogCard | undefined;

  const redemptionOptions = selectedPointsCard
    ? getRedemptionOptions(selectedPointsCard)
    : [];

  const selectedOption = redemptionOptions.find((o) => o.value === redemption) ?? redemptionOptions[0];

  const credits = catalog.filter((c) => c.cardType === 'credit');
  const debits  = catalog.filter((c) => c.cardType !== 'credit');

  return (
    <div className="w-[380px] bg-white select-none">
      {/* Header */}
      <div className="px-4 pt-3.5 pb-3 border-b border-gray-100">
        <div className="flex items-center justify-between">
          <p className="font-bold text-[#1D9E75] text-sm tracking-tight">milkr</p>
          {isEditing && onCancel && (
            <button onClick={onCancel} className="text-xs text-gray-400 hover:text-gray-600 transition-colors">
              ← Back
            </button>
          )}
        </div>
        <p className="text-sm font-semibold text-gray-900 mt-0.5">
          {isEditing ? 'Edit your wallet' : 'Add your cards'}
        </p>
        <p className="text-xs text-gray-400 mt-0.5">Select every card in your wallet</p>
      </div>

      {/* Search bar toggle */}
      {!showSearch ? (
        <div className="px-4 py-2 border-b border-gray-50">
          <button
            onClick={() => setShowSearch(true)}
            className="w-full flex items-center gap-2 text-left text-xs text-gray-400 hover:text-[#1D9E75] transition-colors py-1"
          >
            <span>🔍</span>
            <span>Can't find your card? Search or auto-import it</span>
          </button>
        </div>
      ) : (
        <CardSearch
          onCardAdded={(card) => {
            // If the enriched card is in the catalog list, select it there.
            // Otherwise it was already saved to walletStorage directly inside CardSearch.
            if (catalog.some((c) => c.id === card.id)) {
              setSelected((prev) => new Set([...prev, card.id]));
            }
            setShowSearch(false);
            onSave(); // re-run recommendation with updated wallet
          }}
          onDismiss={() => setShowSearch(false)}
        />
      )}

      {/* Card list */}
      <div className="max-h-[300px] overflow-y-auto divide-y divide-gray-50">
        {credits.length > 0 && (
          <CardGroup label="Credit cards" cards={credits} selected={selected} onToggle={toggle} />
        )}
        {debits.length > 0 && (
          <CardGroup label="Debit cards" cards={debits} selected={selected} onToggle={toggle} />
        )}
        {catalog.length === 0 && (
          <p className="px-4 py-6 text-sm text-gray-400 text-center">
            Catalog loading failed — is the server running?
          </p>
        )}
      </div>

      {/* Redemption preference — card-aware, only shown for points/miles cards */}
      {redemptionOptions.length > 0 && (
        <div className="px-4 py-3 border-t border-gray-100">
          <p className="text-[11px] font-semibold uppercase tracking-wider text-gray-400 mb-2">
            Points redemption goal
            {selectedPointsCard && (
              <span className="normal-case font-normal text-gray-300 ml-1">
                · applies to {selectedPointsCard.issuer} cards
              </span>
            )}
          </p>

          {/* Only show toggles when there are multiple options */}
          {redemptionOptions.length > 1 && (
            <div className="flex gap-1.5">
              {redemptionOptions.map((opt) => (
                <button
                  key={opt.value}
                  onClick={() => setRedemption(opt.value)}
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
          {selectedOption && (
            <p className="text-[11px] text-gray-400 mt-2 leading-relaxed">
              {selectedOption.explanation}
            </p>
          )}
        </div>
      )}

      {/* CTA */}
      <div className="px-4 py-3 border-t border-gray-100">
        <button
          onClick={save}
          disabled={!selected.size || saving}
          className="w-full py-2.5 rounded-xl text-sm font-semibold transition-colors
            bg-[#1D9E75] text-white hover:bg-[#189060] active:bg-[#157a52]
            disabled:opacity-40 disabled:cursor-not-allowed"
        >
          {saving
            ? 'Saving…'
            : selected.size
            ? isEditing ? 'Save changes' : `Add ${selected.size} card${selected.size !== 1 ? 's' : ''}`
            : 'Select at least one card'}
        </button>
      </div>
    </div>
  );
}

// ─── Card group ───────────────────────────────────────────────────────────────

function CardGroup({
  label, cards, selected, onToggle,
}: {
  label: string;
  cards: CatalogCard[];
  selected: Set<string>;
  onToggle: (id: string) => void;
}) {
  return (
    <div>
      <p className="px-4 pt-3 pb-1 text-[11px] font-semibold uppercase tracking-wider text-gray-400">
        {label}
      </p>
      {cards.map((card) => (
        <CardRow key={card.id} card={card} checked={selected.has(card.id)} onToggle={onToggle} />
      ))}
    </div>
  );
}

function CardRow({ card, checked, onToggle }: { card: CatalogCard; checked: boolean; onToggle: (id: string) => void }) {
  return (
    <button
      onClick={() => onToggle(card.id)}
      className={`w-full flex items-center gap-3 px-4 py-2.5 text-left transition-colors hover:bg-gray-50 ${
        checked ? 'bg-[#1D9E75]/[0.04]' : ''
      }`}
    >
      <div className={`w-4 h-4 rounded shrink-0 border-2 flex items-center justify-center transition-colors ${
        checked ? 'bg-[#1D9E75] border-[#1D9E75]' : 'border-gray-300'
      }`}>
        {checked && (
          <svg className="w-2.5 h-2.5 text-white" viewBox="0 0 10 10" fill="none">
            <path d="M1.5 5L3.8 7.5L8.5 2.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
          </svg>
        )}
      </div>
      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium text-gray-800 truncate">{card.name}</p>
        <p className="text-[11px] text-gray-400">
          {card.issuer}
          {card.annualFee > 0 ? ` · $${card.annualFee}/yr` : ' · No annual fee'}
          {' · '}{card.hasRewards ? card.rewardType : 'no rewards'}
        </p>
      </div>
    </button>
  );
}
