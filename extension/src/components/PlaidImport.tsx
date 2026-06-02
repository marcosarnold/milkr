import { useEffect, useState } from 'react';
import type { CatalogCard } from '@/types';
import { walletStorage } from '@/lib/storage';
import { fetchCatalog, matchPlaidCards, type PlaidMatch } from '@/entrypoints/popup/api';

// Raw Plaid card as returned by /plaid/wallet (stored in chrome.storage.local)
interface RawPlaidCard {
  plaid_account_id: string;
  name: string;
  last_four: string | null;
  issuer: string;
}

interface MatchRow {
  plaid: RawPlaidCard;
  match: PlaidMatch;
  catalog: CatalogCard | null;
  selected: boolean;
}

export default function PlaidImport({
  onDone,
  onSkip,
}: {
  onDone: () => void;
  onSkip: () => void;
}) {
  const [rows,    setRows]    = useState<MatchRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving,  setSaving]  = useState(false);
  const [error,   setError]   = useState<string | null>(null);

  useEffect(() => { load(); }, []);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const stored = await chrome.storage.local.get('plaidPending');
      const plaidCards: RawPlaidCard[] = stored.plaidPending ?? [];

      if (!plaidCards.length) {
        // Nothing to import — clear and proceed
        await chrome.storage.local.remove('plaidPending');
        onDone();
        return;
      }

      const [matches, catalog] = await Promise.all([
        matchPlaidCards(plaidCards.map(c => ({ name: c.name, last_four: c.last_four, issuer: c.issuer }))),
        fetchCatalog(),
      ]);

      const catalogMap = new Map(catalog.map(c => [c.id, c]));

      setRows(plaidCards.map((pc, i) => {
        const match   = matches[i];
        const catalog = match.matched_catalog_id ? (catalogMap.get(match.matched_catalog_id) ?? null) : null;
        return { plaid: pc, match, catalog, selected: catalog !== null };
      }));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load bank cards');
    } finally {
      setLoading(false);
    }
  }

  async function save() {
    setSaving(true);
    try {
      const existing = await walletStorage.getValue();
      const existingIds = new Set(existing.map(w => w.catalogId));

      const toAdd = rows.filter(r => r.selected && r.catalog && !existingIds.has(r.catalog.id));

      if (toAdd.length) {
        const newCards = toAdd.map(r => ({
          id: crypto.randomUUID(),
          catalogId: r.catalog!.id,
          cardType:  r.catalog!.cardType,
          redemptionPreference: (r.catalog!.rewardType === 'cashback' ? 'cashback' : 'travel') as any,
          periodSpend: {},
          addedAt: new Date().toISOString(),
        }));
        await walletStorage.setValue([...existing, ...newCards]);
      }

      await chrome.storage.local.remove('plaidPending');
      onDone();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Save failed');
      setSaving(false);
    }
  }

  function toggle(idx: number) {
    setRows(prev => prev.map((r, i) => i === idx ? { ...r, selected: !r.selected } : r));
  }

  const selectedCount = rows.filter(r => r.selected && r.catalog).length;
  const unmatchedCount = rows.filter(r => !r.catalog).length;

  // ── Render ──────────────────────────────────────────────────────────────────

  if (loading) {
    return (
      <div className="w-[380px] bg-white flex flex-col items-center justify-center gap-3 h-52">
        <svg className="animate-spin w-5 h-5 text-[#1D9E75]" viewBox="0 0 24 24" fill="none">
          <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" className="opacity-20" />
          <path d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z" fill="currentColor" className="opacity-75" />
        </svg>
        <p className="text-sm text-gray-500">Matching your cards…</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="w-[380px] bg-white px-6 py-8 text-center space-y-3">
        <p className="text-sm text-gray-700 font-semibold">Could not import cards</p>
        <p className="text-xs text-gray-500 leading-relaxed">{error}</p>
        <button onClick={onSkip} className="text-xs text-[#1D9E75] underline">Continue without importing</button>
      </div>
    );
  }

  return (
    <div className="w-[380px] bg-white">
      {/* Header */}
      <div className="px-4 pt-4 pb-3 border-b border-gray-100">
        <p className="text-sm font-bold text-gray-900">Cards from your bank</p>
        <p className="text-[11px] text-gray-400 mt-0.5 leading-relaxed">
          We matched {rows.filter(r => r.catalog).length} of {rows.length} cards to our catalog.
          Select which to add to your Milkr wallet.
        </p>
      </div>

      {/* Match rows */}
      <div className="divide-y divide-gray-50 max-h-72 overflow-y-auto">
        {rows.map((row, idx) => (
          <MatchRow
            key={row.plaid.plaid_account_id || idx}
            row={row}
            onToggle={() => toggle(idx)}
          />
        ))}
      </div>

      {/* Unmatched notice */}
      {unmatchedCount > 0 && (
        <div className="px-4 py-2 bg-amber-50 border-t border-amber-100">
          <p className="text-[11px] text-amber-700">
            {unmatchedCount} card{unmatchedCount > 1 ? 's' : ''} couldn't be matched — add them manually in Manage Wallet.
          </p>
        </div>
      )}

      {/* Actions */}
      <div className="px-4 py-3 flex items-center gap-2 border-t border-gray-100">
        <button
          onClick={onSkip}
          className="text-xs text-gray-400 hover:text-gray-600 transition-colors"
        >
          Skip
        </button>
        <button
          onClick={save}
          disabled={saving || selectedCount === 0}
          className="flex-1 py-2 rounded-xl text-sm font-semibold bg-[#1D9E75] text-white hover:bg-[#189060] transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {saving ? 'Adding…' : `Add ${selectedCount} card${selectedCount !== 1 ? 's' : ''}`}
        </button>
      </div>
    </div>
  );
}

// ─── Match row ────────────────────────────────────────────────────────────────

function MatchRow({ row, onToggle }: { row: MatchRow; onToggle: () => void }) {
  const { plaid, match, catalog, selected } = row;
  const canSelect = catalog !== null;

  return (
    <div
      className={`flex items-start gap-3 px-4 py-3 ${canSelect ? 'cursor-pointer hover:bg-gray-50' : 'opacity-50'}`}
      onClick={canSelect ? onToggle : undefined}
    >
      {/* Checkbox */}
      <div className={`mt-0.5 w-4 h-4 rounded border-2 flex items-center justify-center shrink-0 transition-colors ${
        selected && canSelect ? 'bg-[#1D9E75] border-[#1D9E75]' : 'border-gray-300 bg-white'
      }`}>
        {selected && canSelect && (
          <svg className="w-2.5 h-2.5 text-white" fill="currentColor" viewBox="0 0 12 12">
            <path d="M10 3L5 8.5 2 5.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" fill="none"/>
          </svg>
        )}
      </div>

      {/* Card info */}
      <div className="flex-1 min-w-0">
        {/* Plaid name */}
        <p className="text-xs text-gray-500 truncate">{plaid.name}{plaid.last_four ? ` ···· ${plaid.last_four}` : ''}</p>
        {/* Catalog match */}
        {catalog ? (
          <div className="flex items-center gap-1.5 mt-0.5">
            <p className="text-sm font-medium text-gray-900 truncate">{catalog.name}</p>
            <ConfBadge score={match.confidence} />
          </div>
        ) : (
          <p className="text-xs text-amber-600 mt-0.5">No catalog match found</p>
        )}
      </div>
    </div>
  );
}

function ConfBadge({ score }: { score: number }) {
  if (score >= 0.9) return (
    <span className="text-[10px] px-1.5 py-0.5 rounded bg-[#1D9E75]/10 text-[#1D9E75] font-medium shrink-0">
      ✓ Matched
    </span>
  );
  return (
    <span className="text-[10px] px-1.5 py-0.5 rounded bg-yellow-50 text-yellow-700 font-medium shrink-0">
      ~{Math.round(score * 100)}%
    </span>
  );
}
