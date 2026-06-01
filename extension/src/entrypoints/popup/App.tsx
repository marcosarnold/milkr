import { useEffect, useState } from 'react';
import type { CatalogCard, MerchantCategory, MerchantContext, Recommendation } from '@/types';
import { walletStorage } from '@/lib/storage';
import { buildRecommendation } from '@/lib/rewards/engine';
import { classifyMerchant, fetchCatalog, fetchOverrides } from './api';
import RecommendationView from './RecommendationView';
import WalletSetup from './WalletSetup';

// Shape written by background.ts into chrome.storage.session
interface SessionCheckoutCtx {
  url: string;
  domain: string;
  transactionAmount: number | null;
  bnpl: { klarna: boolean; affirm: boolean; afterpay: boolean };
  detectedAt: number;
}

type Phase =
  | { tag: 'loading' }
  | { tag: 'not-at-checkout' }
  | { tag: 'wallet-setup'; catalog: CatalogCard[] }
  | { tag: 'recommendation'; rec: Recommendation }
  | { tag: 'error'; msg: string };

export default function App() {
  const [phase, setPhase] = useState<Phase>({ tag: 'loading' });

  useEffect(() => { init(); }, []);

  async function init() {
    setPhase({ tag: 'loading' });
    try {
      // 1. Find the active tab (activeTab permission grants access when popup opens)
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab?.id) return setPhase({ tag: 'not-at-checkout' });

      // 2. Read checkout context written by the content script → background
      const stored = await chrome.storage.session.get(`checkout:${tab.id}`);
      const sessionCtx = stored[`checkout:${tab.id}`] as SessionCheckoutCtx | undefined;
      if (!sessionCtx) return setPhase({ tag: 'not-at-checkout' });

      // 3. Fetch wallet + catalog in parallel — catalog needed for both setup and recommendation
      const [wallet, catalog, overrides] = await Promise.all([
        walletStorage.getValue(),
        fetchCatalog(),
        fetchOverrides(),
      ]);

      if (!wallet.length) {
        return setPhase({ tag: 'wallet-setup', catalog });
      }

      // 4. Classify merchant via Claude Haiku on the server
      const cls = await classifyMerchant(sessionCtx.domain, tab.title);

      const context: MerchantContext = {
        url: sessionCtx.url,
        domain: sessionCtx.domain,
        merchantName: cls.merchant_name,
        category: cls.category as MerchantCategory,
        mcc: cls.mcc,
        transactionAmount: sessionCtx.transactionAmount,
        bnpl: sessionCtx.bnpl,
        contextDependent: cls.context_dependent,
        confidence: cls.confidence,
        detectedAt: sessionCtx.detectedAt,
      };

      // 5. Run reward engine locally — all math stays in the browser
      const catalogMap = new Map(catalog.map((c) => [c.id, c]));
      const rec = await buildRecommendation(wallet, catalogMap, overrides, context);
      setPhase({ tag: 'recommendation', rec });
    } catch (e) {
      setPhase({ tag: 'error', msg: e instanceof Error ? e.message : String(e) });
    }
  }

  switch (phase.tag) {
    case 'loading':
      return <LoadingScreen />;
    case 'not-at-checkout':
      return <NotAtCheckout />;
    case 'wallet-setup':
      return <WalletSetup catalog={phase.catalog} onSave={init} />;
    case 'recommendation':
      return <RecommendationView rec={phase.rec} onManageWallet={init} />;
    case 'error':
      return <ErrorScreen msg={phase.msg} onRetry={init} />;
  }
}

// ─── Simple screens ───────────────────────────────────────────────────────────

function LoadingScreen() {
  return (
    <div className="flex items-center justify-center h-28">
      <div className="flex items-center gap-2 text-gray-400">
        <svg className="animate-spin w-4 h-4" viewBox="0 0 24 24" fill="none">
          <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" className="opacity-20" />
          <path d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z" fill="currentColor" className="opacity-75" />
        </svg>
        <span className="text-sm">Finding best card…</span>
      </div>
    </div>
  );
}

function NotAtCheckout() {
  return (
    <div className="flex flex-col items-center justify-center gap-3 h-44 px-8 text-center">
      <span className="text-3xl">💳</span>
      <div>
        <p className="text-sm font-semibold text-gray-800">Not at checkout</p>
        <p className="text-xs text-gray-500 mt-1 leading-relaxed">
          Head to a checkout page and Milkr will surface your best card automatically.
        </p>
      </div>
      <p className="text-[10px] text-gray-300 font-semibold tracking-widest uppercase">milkr</p>
    </div>
  );
}

function ErrorScreen({ msg, onRetry }: { msg: string; onRetry: () => void }) {
  const isOffline = msg.toLowerCase().includes('failed') || msg.toLowerCase().includes('fetch');
  return (
    <div className="flex flex-col items-center gap-3 p-6 text-center">
      <p className="text-sm font-semibold text-gray-800">
        {isOffline ? 'Server offline' : 'Something went wrong'}
      </p>
      <p className="text-xs text-gray-400 max-w-[260px] leading-relaxed">{msg}</p>
      <button
        onClick={onRetry}
        className="text-xs px-4 py-1.5 bg-gray-100 rounded-full hover:bg-gray-200 transition-colors font-medium"
      >
        Retry
      </button>
    </div>
  );
}
