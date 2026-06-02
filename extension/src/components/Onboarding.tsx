import { useState } from 'react';

// ─── Step content ─────────────────────────────────────────────────────────────

const STEPS = [
  {
    icon: '🛒',
    title: 'Shop anywhere online',
    body: "Milkr watches for checkout pages automatically. No clicking needed — it lights up when you're ready to pay.",
  },
  {
    icon: '💳',
    title: 'See your best card instantly',
    body: "Milkr ranks every card in your wallet by how much you'll earn back — including debit cards and buy now pay later options.",
  },
  {
    icon: '🐄',
    title: 'Never leave rewards behind',
    body: "Tap 'why?' on any recommendation to see the full breakdown and exact dollar math. Your data never leaves your device.",
  },
];

// ─── Onboarding ───────────────────────────────────────────────────────────────
// 3-step carousel shown to first-time users with an empty wallet.
// Also reachable from the "how it works" link in the popup footer at any time.
//
// onGetStarted → marks seen + drops user into wallet/card-add flow
// onSkip       → marks seen + re-runs init() (may land on not-at-checkout)

export default function Onboarding({
  onGetStarted,
  onSkip,
}: {
  onGetStarted: () => void;
  onSkip: () => void;
}) {
  const [step, setStep] = useState(0);
  const current = STEPS[step];
  const isFirst = step === 0;
  const isLast  = step === STEPS.length - 1;

  return (
    <div className="w-[380px] bg-white select-none">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-gray-100">
        <p className="font-bold text-[#1D9E75] text-sm tracking-tight">milkr</p>
        <button
          onClick={onSkip}
          className="text-xs text-gray-400 hover:text-gray-600 transition-colors"
        >
          Skip
        </button>
      </div>

      {/* Step content — fixed height so layout doesn't jump between steps */}
      <div className="px-8 pt-8 pb-6 text-center" style={{ minHeight: 196 }}>
        <div className="text-5xl mb-4 leading-none">{current.icon}</div>
        <p className="text-sm font-bold text-gray-900 mb-2 leading-snug">{current.title}</p>
        <p className="text-sm text-gray-500 leading-relaxed max-w-[260px] mx-auto">
          {current.body}
        </p>
      </div>

      {/* Step dots */}
      <div className="flex items-center justify-center gap-2 pb-4">
        {STEPS.map((_, i) => (
          <button
            key={i}
            onClick={() => setStep(i)}
            className={`rounded-full transition-all ${
              i === step
                ? 'w-4 h-1.5 bg-[#1D9E75]'   // active: wider pill
                : 'w-1.5 h-1.5 bg-gray-200 hover:bg-gray-300'
            }`}
            aria-label={`Go to step ${i + 1}`}
          />
        ))}
      </div>

      {/* Navigation */}
      <div className="px-4 pb-5 flex items-center gap-2">
        {!isFirst ? (
          <button
            onClick={() => setStep(step - 1)}
            className="flex-1 py-2.5 rounded-xl text-sm font-medium bg-gray-100 text-gray-600 hover:bg-gray-200 transition-colors"
          >
            ← Back
          </button>
        ) : (
          <div className="flex-1" /> // spacer keeps Next/Get started on the right on step 0
        )}

        {isLast ? (
          <button
            onClick={onGetStarted}
            className="flex-1 py-2.5 rounded-xl text-sm font-semibold bg-[#1D9E75] text-white hover:bg-[#189060] active:bg-[#157a52] transition-colors"
          >
            Get started →
          </button>
        ) : (
          <button
            onClick={() => setStep(step + 1)}
            className="flex-1 py-2.5 rounded-xl text-sm font-semibold bg-[#1D9E75] text-white hover:bg-[#189060] active:bg-[#157a52] transition-colors"
          >
            Next →
          </button>
        )}
      </div>
    </div>
  );
}
