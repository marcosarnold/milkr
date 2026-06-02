import { useEffect, useState } from 'react';
import type { CatalogCard, MerchantCategory, MerchantContext, Recommendation } from '@/types';
import { walletStorage, preferencesStorage, historyDB, spendDB } from '@/lib/storage';
import { buildRecommendation } from '@/lib/rewards/engine';
import { classifyMerchant, fetchCatalog, fetchOverrides, createLinkToken, checkPlaidSession, plaidLinkUrl } from './api';
import RecommendationView from './RecommendationView';
import WalletSetup from './WalletSetup';
import Onboarding from '@/components/Onboarding';
import CardRecommendations from '@/components/CardRecommendations';
import PlaidImport from '@/components/PlaidImport';

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
  | { tag: 'onboarding' }
  | { tag: 'not-at-checkout' }
  | { tag: 'wallet-setup'; catalog: CatalogCard[] }
  | { tag: 'wallet-editing'; catalog: CatalogCard[]; currentIds: string[] }
  | { tag: 'plaid-connecting' }
  | { tag: 'plaid-import' }
  | { tag: 'recommendation'; rec: Recommendation }
  | { tag: 'error'; msg: string };

type ActiveTab = 'main' | 'for-you';

export default function App() {
  const [phase,         setPhase]         = useState<Phase>({ tag: 'loading' });
  const [activeTab,     setActiveTab]     = useState<ActiveTab>('main');
  const [walletHasCards, setWalletHasCards] = useState(false);

  useEffect(() => { init(); }, []);

  async function init() {
    setPhase({ tag: 'loading' });
    try {
      // 1. Wallet + prefs loaded first — needed for the onboarding gate
      const [wallet, prefs] = await Promise.all([
        walletStorage.getValue(),
        preferencesStorage.getValue(),
      ]);

      setWalletHasCards(wallet.length > 0);

      // Check if a Plaid import is ready or in-flight
      const plaidLocal = await chrome.storage.local.get(['plaidPending', 'plaidSession', 'plaidTabId']);

      async function closePlaidTab() {
        if (plaidLocal.plaidTabId) {
          chrome.tabs.remove(plaidLocal.plaidTabId).catch(() => {});
          await chrome.storage.local.remove('plaidTabId');
        }
      }

      if (plaidLocal.plaidPending) {
        await closePlaidTab();
        return setPhase({ tag: 'plaid-import' });
      }
      if (plaidLocal.plaidSession) {
        const cards = await checkPlaidSession(plaidLocal.plaidSession).catch(() => null);
        if (cards && cards.length > 0) {
          await closePlaidTab();
          await chrome.storage.local.set({ plaidPending: cards });
          await chrome.storage.local.remove('plaidSession');
          return setPhase({ tag: 'plaid-import' });
        }
        return setPhase({ tag: 'plaid-connecting' });
      }

      // Show onboarding on first launch with an empty wallet
      if (!wallet.length && !prefs.hasSeenOnboarding) {
        return setPhase({ tag: 'onboarding' });
      }

      // 2. Active tab + checkout context
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab?.id) return setPhase({ tag: 'not-at-checkout' });

      const stored = await chrome.storage.session.get(`checkout:${tab.id}`);
      const sessionCtx = stored[`checkout:${tab.id}`] as SessionCheckoutCtx | undefined;
      if (!sessionCtx) return setPhase({ tag: 'not-at-checkout' });

      // 3. Catalog + overrides + classify — all independent, fire in parallel
      const [catalog, overrides, cls] = await Promise.all([
        fetchCatalog(),
        fetchOverrides(),
        classifyMerchant(sessionCtx.domain, tab.title),
      ]);

      if (!wallet.length) {
        return setPhase({ tag: 'wallet-setup', catalog });
      }

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

      // 4. Run reward engine locally — all math stays in the browser
      const catalogMap = new Map(catalog.map((c) => [c.id, c]));
      const rec = await buildRecommendation(wallet, catalogMap, overrides, context);

      // 5. Persist history + spend — with deduplication so navigating
      //    to "Manage wallet" and back doesn't create duplicate entries.
      //
      //    History ID is keyed to the specific checkout event (domain + detectedAt),
      //    not to this popup open. db.put() is an upsert, so re-saving the same
      //    id just overwrites the record rather than adding a new one.
      const historyId = `${context.domain}:${sessionCtx.detectedAt}`;
      const best = rec.ranked[0];
      historyDB.save({
        id: historyId,
        domain: context.domain,
        merchantName: context.merchantName,
        category: context.category,
        transactionAmount: context.transactionAmount,
        chosenCardId: best?.wallet.catalogId ?? null,
        expectedValue: best?.resolved.expectedValue ?? null,
        generatedAt: rec.generatedAt,
      });

      // Spend is additive — guard with a session flag so we only add it once
      // per checkout event, regardless of how many times the popup is opened.
      const spendKey = `spendTracked:${historyId}`;
      const tracked = await chrome.storage.session.get(spendKey);
      if (!tracked[spendKey] && best && context.transactionAmount) {
        chrome.storage.session.set({ [spendKey]: true });
        spendDB.addSpend(best.catalog.id, context.category, context.transactionAmount);
      }

      setPhase({ tag: 'recommendation', rec });
    } catch (e) {
      setPhase({ tag: 'error', msg: e instanceof Error ? e.message : String(e) });
    }
  }

  // Called from Onboarding "Get started" (goToCards=true) or "Skip" (goToCards=false)
  async function dismissOnboarding(goToCards: boolean) {
    const prefs = await preferencesStorage.getValue();
    await preferencesStorage.setValue({ ...prefs, hasSeenOnboarding: true });
    if (goToCards) {
      const catalog = await fetchCatalog().catch(() => [] as CatalogCard[]);
      setPhase({ tag: 'wallet-setup', catalog });
    } else {
      init();
    }
  }

  async function openPlaidLink() {
    try {
      const { linkToken, sessionToken } = await createLinkToken();
      const tab = await chrome.tabs.create({ url: plaidLinkUrl(linkToken, sessionToken) });
      // Store session + tab ID so we can poll and close the tab when done
      await chrome.storage.local.set({ plaidSession: sessionToken, plaidTabId: tab.id });
      setPhase({ tag: 'plaid-connecting' });
    } catch (e) {
      setPhase({ tag: 'error', msg: e instanceof Error ? e.message : String(e) });
    }
  }

  async function openWalletEditor() {
    setPhase({ tag: 'loading' });
    try {
      const [wallet, catalog] = await Promise.all([walletStorage.getValue(), fetchCatalog()]);
      const currentIds = wallet.map((w) => w.catalogId);
      setPhase({ tag: 'wallet-editing', catalog, currentIds });
    } catch (e) {
      setPhase({ tag: 'error', msg: e instanceof Error ? e.message : String(e) });
    }
  }

  switch (phase.tag) {
    case 'loading':
      return <LoadingScreen />;
    case 'onboarding':
      return (
        <Onboarding
          onGetStarted={() => dismissOnboarding(true)}
          onSkip={() => dismissOnboarding(false)}
        />
      );
    case 'not-at-checkout':
      return (
        <div className="w-[380px] bg-white">
          {walletHasCards && <TabBar activeTab={activeTab} onChange={setActiveTab} />}
          {activeTab === 'for-you' && walletHasCards
            ? <CardRecommendations />
            : <NotAtCheckout onShowOnboarding={() => setPhase({ tag: 'onboarding' })} />
          }
        </div>
      );
    case 'plaid-connecting':
      return <PlaidConnecting onCheck={init} />;
    case 'plaid-import':
      return <PlaidImport onDone={init} onSkip={async () => {
        await chrome.storage.local.remove(['plaidPending', 'plaidSession', 'plaidTabId']);
        init();
      }} />;
    case 'wallet-setup':
      return <WalletSetup catalog={phase.catalog} onSave={init} onConnectBank={openPlaidLink} />;
    case 'wallet-editing':
      return (
        <WalletSetup
          catalog={phase.catalog}
          initialSelected={phase.currentIds}
          onSave={init}
          onCancel={init}
          onConnectBank={openPlaidLink}
        />
      );
    case 'recommendation':
      return (
        <div className="w-[380px] bg-white">
          <TabBar activeTab={activeTab} onChange={setActiveTab} />
          {activeTab === 'for-you'
            ? <CardRecommendations />
            : <RecommendationView
                rec={phase.rec}
                onManageWallet={openWalletEditor}
                onShowOnboarding={() => setPhase({ tag: 'onboarding' })}
                onShowForYou={() => setActiveTab('for-you')}
              />
          }
        </div>
      );
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

function PlaidConnecting({ onCheck }: { onCheck: () => void }) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 h-44 px-8 text-center">
      <span className="text-3xl">🏦</span>
      <div>
        <p className="text-sm font-semibold text-gray-800">Connecting your bank</p>
        <p className="text-xs text-gray-500 mt-1 leading-relaxed">
          Complete the Plaid flow in the browser tab, then come back and check.
        </p>
      </div>
      <button
        onClick={onCheck}
        className="text-xs px-4 py-1.5 bg-[#1D9E75] text-white rounded-full hover:bg-[#189060] transition-colors font-medium"
      >
        Check for imported cards
      </button>
    </div>
  );
}

function NotAtCheckout({ onShowOnboarding }: { onShowOnboarding: () => void }) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 h-44 px-8 text-center">
      <span className="text-3xl">💳</span>
      <div>
        <p className="text-sm font-semibold text-gray-800">Not at checkout</p>
        <p className="text-xs text-gray-500 mt-1 leading-relaxed">
          Head to a checkout page and Milkr will surface your best card automatically.
        </p>
      </div>
      <button
        onClick={onShowOnboarding}
        className="text-[11px] text-gray-300 hover:text-gray-500 transition-colors"
      >
        How it works
      </button>
    </div>
  );
}

// ─── Tab navigation ───────────────────────────────────────────────────────────

function TabBar({ activeTab, onChange }: { activeTab: ActiveTab; onChange: (t: ActiveTab) => void }) {
  return (
    <div className="flex border-b border-gray-100">
      <TabButton label="Best card" active={activeTab === 'main'}     onClick={() => onChange('main')}     />
      <TabButton label="For you"   active={activeTab === 'for-you'}  onClick={() => onChange('for-you')}  />
    </div>
  );
}

function TabButton({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className={`flex-1 py-2.5 text-xs font-medium transition-colors border-b-2 -mb-px ${
        active
          ? 'text-[#1D9E75] border-[#1D9E75]'
          : 'text-gray-400 border-transparent hover:text-gray-600'
      }`}
    >
      {label}
    </button>
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
