import type { AppSettings, Usage } from '@hirora/contracts';

export function priceKey(provider: string, model: string): string {
  return `${provider}:${model}`;
}

/** Cost from user-entered prices only. Unknown price → null (never guessed). */
export function estimateCostUsd(settings: AppSettings, provider: string, model: string, usage: Usage | null): number | null {
  if (!usage) return null;
  const price = settings.budget.prices[priceKey(provider, model)];
  if (!price) return null;
  const input = usage.inputTokens ?? 0;
  const output = usage.outputTokens ?? 0;
  return (input / 1_000_000) * price.inputPer1M + (output / 1_000_000) * price.outputPer1M;
}

export function answerBudgetCheck(
  settings: AppSettings,
  today: { answers: number },
  monthCostUsd: number,
): { ok: true } | { ok: false; reason: string } {
  if (today.answers >= settings.budget.dailyAnswerLimit) {
    return { ok: false, reason: `Daily answer limit reached (${settings.budget.dailyAnswerLimit}). Raise it in Settings → Budget.` };
  }
  const cap = settings.budget.monthlyUsdCap;
  if (cap !== null && monthCostUsd >= cap) {
    return { ok: false, reason: `Monthly spend cap reached ($${cap.toFixed(2)} of user-priced usage). Raise it in Settings → Budget.` };
  }
  return { ok: true };
}

export function sttBudgetCheck(settings: AppSettings, today: { sttMinutes: number }): { ok: true } | { ok: false; reason: string } {
  if (today.sttMinutes >= settings.budget.dailySttMinutesLimit) {
    return {
      ok: false,
      reason: `Daily transcription limit reached (${settings.budget.dailySttMinutesLimit} min). Listening paused; raise it in Settings → Budget.`,
    };
  }
  return { ok: true };
}
