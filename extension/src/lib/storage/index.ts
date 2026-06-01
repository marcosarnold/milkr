import { storage } from 'wxt/storage';
import { openDB, type IDBPDatabase } from 'idb';
import type { WalletCard, UserPreferences, RecommendationHistoryEntry } from '@/types';

// ─── chrome.storage keys (small, sync-able data) ─────────────────────────────

export const walletStorage = storage.defineItem<WalletCard[]>(
  'local:wallet',
  { fallback: [] }
);

export const preferencesStorage = storage.defineItem<UserPreferences>(
  'local:preferences',
  {
    fallback: {
      defaultRedemption: 'cash',
      showBNPL: true,
      showGiftCardTips: true,
      internationalMode: false,
    },
  }
);

// ─── IndexedDB — transaction history (larger, structured) ────────────────────

const DB_NAME = 'cashcow';
const DB_VERSION = 1;

let _db: IDBPDatabase | null = null;

async function getDB(): Promise<IDBPDatabase> {
  if (_db) return _db;
  _db = await openDB(DB_NAME, DB_VERSION, {
    upgrade(db) {
      // Recommendation history — one row per checkout recommendation
      if (!db.objectStoreNames.contains('recommendations')) {
        const store = db.createObjectStore('recommendations', { keyPath: 'id' });
        store.createIndex('by_date', 'generatedAt');
        store.createIndex('by_domain', 'domain');
      }
      // Spend tracking per card per category per period
      if (!db.objectStoreNames.contains('spend')) {
        db.createObjectStore('spend', { keyPath: 'key' }); // key = cardId:category:period
      }
    },
  });
  return _db;
}

export interface RecommendationHistoryEntry {
  id: string;
  domain: string;
  merchantName: string;
  category: string;
  transactionAmount: number | null;
  chosenCardId: string | null;
  expectedValue: number | null;
  generatedAt: number;
}

export const historyDB = {
  async save(entry: RecommendationHistoryEntry): Promise<void> {
    const db = await getDB();
    await db.put('recommendations', entry);
  },

  async recent(limit = 50): Promise<RecommendationHistoryEntry[]> {
    const db = await getDB();
    const all = await db.getAllFromIndex('recommendations', 'by_date');
    return all.reverse().slice(0, limit);
  },

  async totalSaved(): Promise<number> {
    const db = await getDB();
    const all = await db.getAll('recommendations');
    return all.reduce((sum, r) => sum + (r.expectedValue ?? 0), 0);
  },
};

export const spendDB = {
  /** Record spend against a card's category cap */
  async addSpend(cardId: string, category: string, amount: number): Promise<void> {
    const db = await getDB();
    const period = getCurrentPeriod();
    const key = `${cardId}:${category}:${period}`;
    const existing = (await db.get('spend', key))?.amount ?? 0;
    await db.put('spend', { key, cardId, category, period, amount: existing + amount });
  },

  async getSpend(cardId: string, category: string): Promise<number> {
    const db = await getDB();
    const period = getCurrentPeriod();
    const key = `${cardId}:${category}:${period}`;
    return (await db.get('spend', key))?.amount ?? 0;
  },
};

/** Returns YYYY-QN for quarterly-capped cards, YYYY-MM for monthly */
function getCurrentPeriod(): string {
  const now = new Date();
  const q = Math.floor(now.getMonth() / 3) + 1;
  return `${now.getFullYear()}-Q${q}`;
}
