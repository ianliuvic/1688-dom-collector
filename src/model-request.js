// DeepSeek thinking-mode parameters, shared by every model call in the collector.
//
// The API accepts `{"thinking": {"type": "enabled"|"disabled"}}` plus
// `reasoning_effort`, and it also maps a wider set of effort names onto its own
// low/high/max levels.
//
// IMPORTANT: the chain of thought is billed as OUTPUT tokens and counts against
// `max_tokens`. A call with a tight output cap can therefore spend the entire
// budget on reasoning and return an empty or truncated answer — which is how
// product_sku_audits rows end up with `model_response_not_json`. Keep a generous
// `max_tokens` wherever thinking is enabled.

export const DEFAULT_REASONING_EFFORT = 'high';

const EFFORT_ALIASES = {
  minimal: 'low',
  low: 'low',
  medium: 'high',
  high: 'high',
  xhigh: 'high',
  max: 'max',
  ultra: 'max',
};

const DISABLED_VALUES = new Set(['off', 'none', 'disabled', 'false', '0']);

/** Resolve a configured effort to low/high/max, or null when thinking is off. */
export function resolveReasoningEffort(value, fallback = DEFAULT_REASONING_EFFORT) {
  const raw = String(value ?? '').trim().toLowerCase();
  const fallbackEffort = EFFORT_ALIASES[String(fallback ?? '').trim().toLowerCase()]
    ?? fallback ?? DEFAULT_REASONING_EFFORT;
  if (!raw) return EFFORT_ALIASES[String(fallbackEffort).trim().toLowerCase()] ?? fallbackEffort;
  if (DISABLED_VALUES.has(raw)) return null;
  // An unrecognised value must not silently disable thinking: keep the fallback.
  return EFFORT_ALIASES[raw] ?? EFFORT_ALIASES[String(fallbackEffort).trim().toLowerCase()]
    ?? fallbackEffort;
}

/** Add the thinking parameters to a chat-completions request body. */
export function applyReasoning(body, value, fallback = DEFAULT_REASONING_EFFORT) {
  const effort = resolveReasoningEffort(value, fallback);
  if (!effort) return { ...body, thinking: { type: 'disabled' } };
  return { ...body, reasoning_effort: effort, thinking: { type: 'enabled' } };
}
