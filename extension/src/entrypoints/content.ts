import type { MerchantContext, BNPLAvailability } from '@/types';

// ─── Multi-signal checkout detection ─────────────────────────────────────────
// Requires 2-of-3 signals to avoid false positives on cart/product pages.

const CHECKOUT_URL_PATTERNS = [
  /\/checkout/i,
  /\/payment/i,
  /\/order/i,
  /\/pay\b/i,
  /\/purchase/i,
  /\/confirm/i,
  /\/billing/i,
];

const PAYMENT_FIELD_SELECTORS = [
  'input[name*="card"]',
  'input[name*="credit"]',
  'input[autocomplete="cc-number"]',
  'input[autocomplete="cc-name"]',
  '[data-testid*="payment"]',
  '[class*="payment-form"]',
  '[id*="payment-form"]',
  'button[type="submit"]',
];

const TOTAL_SELECTORS = [
  '[class*="order-total"]',
  '[class*="grand-total"]',
  '[class*="total-price"]',
  '[class*="checkout-total"]',
  '[data-testid*="total"]',
  '[id*="total"]',
];

// ─── BNPL provider detection ──────────────────────────────────────────────────

const BNPL_SIGNALS: Record<keyof BNPLAvailability, (string | RegExp)[]> = {
  klarna: ['klarna', 'klarna-placement', 'klarna-checkout-container', /klarna/i],
  affirm: ['affirm-as-low-as', '__affirm-checkout', /affirm/i],
  afterpay: ['afterpay-widget', 'afterpay-placement', 'square-afterpay', /afterpay|clearpay/i],
};

function detectBNPL(): BNPLAvailability {
  const html = document.body.innerHTML;
  const result: BNPLAvailability = { klarna: false, affirm: false, afterpay: false };

  for (const [provider, signals] of Object.entries(BNPL_SIGNALS)) {
    result[provider as keyof BNPLAvailability] = signals.some((signal) =>
      typeof signal === 'string'
        ? document.querySelector(`[class*="${signal}"], [id*="${signal}"], ${signal}`) !== null
        : signal.test(html)
    );
  }

  return result;
}

// ─── Amount extraction ────────────────────────────────────────────────────────
// Semantic extraction — looks for largest plausible dollar amount near
// "total", "order total", "grand total" labels.

function extractAmount(): number | null {
  for (const selector of TOTAL_SELECTORS) {
    const el = document.querySelector(selector);
    if (el) {
      const amount = parseAmount(el.textContent ?? '');
      if (amount !== null) return amount;
    }
  }

  // Fallback: scan text nodes for "Total: $47.99" patterns
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  const amounts: number[] = [];
  let node: Text | null;

  while ((node = walker.nextNode() as Text | null)) {
    const text = node.textContent ?? '';
    if (/total|amount|due|pay/i.test(text)) {
      const amount = parseAmount(text);
      if (amount !== null) amounts.push(amount);
    }
  }

  const valid = amounts.filter((a) => a > 0.5 && a < 50_000);
  return valid.length > 0 ? valid[valid.length - 1] : null;
}

function parseAmount(text: string): number | null {
  const match = text.match(/\$\s*([\d,]+\.?\d{0,2})/);
  if (!match) return null;
  const val = parseFloat(match[1].replace(',', ''));
  return isNaN(val) ? null : val;
}

// ─── Checkout signal scoring ──────────────────────────────────────────────────

function isCheckoutPage(): boolean {
  let signals = 0;
  if (CHECKOUT_URL_PATTERNS.some((p) => p.test(window.location.href))) signals++;
  if (PAYMENT_FIELD_SELECTORS.some((s) => document.querySelector(s) !== null)) signals++;
  if (extractAmount() !== null) signals++;
  return signals >= 2;
}

// ─── Main entrypoint ──────────────────────────────────────────────────────────
// All mutable state and side effects live inside main() per WXT's content
// script contract — module-level code runs during build analysis too.

export default defineContentScript({
  matches: ['https://*/*'],
  main() {
    let lastHref = window.location.href;
    let debounceTimer: ReturnType<typeof setTimeout> | null = null;

    function runDetection() {
      if (!isCheckoutPage()) return;

      const context: Partial<MerchantContext> = {
        url: window.location.href,
        domain: window.location.hostname,
        transactionAmount: extractAmount(),
        bnpl: detectBNPL(),
        detectedAt: Date.now(),
      };

      chrome.runtime.sendMessage({ type: 'CHECKOUT_DETECTED', context });
    }

    function scheduleDetection() {
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(runDetection, 300);
    }

    // Run on initial load
    runDetection();

    // Watch for SPA navigation — React/Next.js don't fire page load events
    const observer = new MutationObserver(() => {
      if (window.location.href !== lastHref) {
        lastHref = window.location.href;
        scheduleDetection();
        return;
      }
      scheduleDetection();
    });

    observer.observe(document.body, { childList: true, subtree: true });
  },
});
