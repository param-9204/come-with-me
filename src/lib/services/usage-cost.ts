/**
 * Estimated cost of one metered call, from list prices.
 *
 * NOT VERIFIED: these prices were entered from the implementer's knowledge,
 * not checked against the providers' current pricing pages. Free monthly
 * tiers (Google, Mapbox) and negotiated discounts are not deducted, so the
 * estimates are an upper bound. Verify before using them for billing, and
 * correct them with PRICING_OVERRIDES_JSON, e.g.
 *   PRICING_OVERRIDES_JSON={"groq:openai/gpt-oss-20b":{"inputPer1M":0.1,"outputPer1M":0.5}}
 *
 * A provider/model with no entry gets a NULL cost (not 0), so unpriced usage
 * stays visible in the extraction_daily_costs view (unpriced_calls).
 * Token counts are always stored, so cost can be recomputed later.
 */

export interface PriceEntry {
  inputPer1M?: number;
  cachedInputPer1M?: number;
  outputPer1M?: number;
  perAudioMinute?: number;
  perRequest?: number;
  perImage?: number;
}

/** Keys are `provider:model-or-operation`; the longest matching prefix wins (gpt-4o-mini before gpt-4o). */
const DEFAULT_PRICES: Record<string, PriceEntry> = {
  // OpenAI chat / vision (USD per 1M tokens)
  'openai:gpt-4o-mini': { inputPer1M: 0.15, cachedInputPer1M: 0.075, outputPer1M: 0.6 },
  'openai:gpt-4o': { inputPer1M: 2.5, cachedInputPer1M: 1.25, outputPer1M: 10 },
  'openai:gpt-4.1-mini': { inputPer1M: 0.4, cachedInputPer1M: 0.1, outputPer1M: 1.6 },
  'openai:gpt-4.1': { inputPer1M: 2, cachedInputPer1M: 0.5, outputPer1M: 8 },
  // Speech to text (USD per audio minute)
  'openai:whisper-1': { perAudioMinute: 0.006 },
  'groq:whisper-large-v3-turbo': { perAudioMinute: 0.04 / 60 },
  'groq:whisper-large-v3': { perAudioMinute: 0.111 / 60 },
  // Z.ai: glm-4.6v-flash is the free vision model (see glm-ocr.service.ts).
  'zai:glm-4.6v-flash': { inputPer1M: 0, outputPer1M: 0 },
  // Google Maps Platform (USD per request). Text Search with displayName /
  // formattedAddress / addressComponents in the field mask bills at the Pro tier.
  'google:places_text_search': { perRequest: 0.032 },
  'google:geocode': { perRequest: 0.005 },
  'google:reverse_geocode': { perRequest: 0.005 },
  // Cloud Vision TEXT_DETECTION (USD per image)
  'google:cloud_vision': { perImage: 0.0015 },
};

let cachedOverrides: { raw: string | undefined; prices: Record<string, PriceEntry> } | null = null;

function priceTable(): Record<string, PriceEntry> {
  const raw = process.env.PRICING_OVERRIDES_JSON;
  if (cachedOverrides && cachedOverrides.raw === raw) return cachedOverrides.prices;
  let overrides: Record<string, PriceEntry> = {};
  if (raw?.trim()) {
    try {
      overrides = JSON.parse(raw);
    } catch {
      console.warn('[pricing] PRICING_OVERRIDES_JSON is not valid JSON; using default prices.');
    }
  }
  cachedOverrides = { raw, prices: { ...DEFAULT_PRICES, ...overrides } };
  return cachedOverrides.prices;
}

export function findPrice(provider: string, modelOrOperation: string | null | undefined): PriceEntry | null {
  const key = `${provider}:${(modelOrOperation || '').toLowerCase()}`;
  let best: string | null = null;
  for (const candidate of Object.keys(priceTable())) {
    if (key.startsWith(candidate.toLowerCase()) && (!best || candidate.length > best.length)) best = candidate;
  }
  return best ? priceTable()[best] : null;
}

export interface MeteredUsage {
  provider: string;
  model?: string | null;
  operation: string;
  inputTokens?: number | null;
  outputTokens?: number | null;
  cachedInputTokens?: number | null;
  audioSeconds?: number | null;
  images?: number | null;
  requestUnits?: number | null;
}

/** Estimated USD cost, or null when no price is known. Token-priced entries ignore request counts. */
export function estimateCostUsd(usage: MeteredUsage): { costUsd: number | null; source: 'price_table' | 'free' | null } {
  const price = findPrice(usage.provider, usage.model) ?? findPrice(usage.provider, usage.operation);
  if (!price) return { costUsd: null, source: null };

  let cost = 0;
  if (price.inputPer1M !== undefined || price.outputPer1M !== undefined) {
    const input = usage.inputTokens || 0;
    const cached = Math.min(input, usage.cachedInputTokens || 0);
    const cachedRate = price.cachedInputPer1M ?? price.inputPer1M ?? 0;
    cost += ((input - cached) * (price.inputPer1M || 0) + cached * cachedRate + (usage.outputTokens || 0) * (price.outputPer1M || 0)) / 1e6;
  }
  if (price.perAudioMinute !== undefined) cost += ((usage.audioSeconds || 0) / 60) * price.perAudioMinute;
  if (price.perImage !== undefined) cost += (usage.images || 0) * price.perImage;
  if (price.perRequest !== undefined) cost += (usage.requestUnits ?? 1) * price.perRequest;

  const rounded = Math.round(cost * 1e6) / 1e6;
  return { costUsd: rounded, source: rounded === 0 ? 'free' : 'price_table' };
}

/** Usage a call reports back to executeAICall for the extraction_run_calls log. */
export interface AIUsage {
  inputTokens?: number | null;
  outputTokens?: number | null;
  totalTokens?: number | null;
  cachedInputTokens?: number | null;
  reasoningTokens?: number | null;
  audioSeconds?: number | null;
  finishReason?: string | null;
}

/** Token usage from an OpenAI-compatible chat response (OpenAI and Groq). */
export function chatUsage(response: {
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
    prompt_tokens_details?: { cached_tokens?: number } | null;
    completion_tokens_details?: { reasoning_tokens?: number } | null;
  } | null;
  choices?: Array<{ finish_reason?: string | null }>;
}): AIUsage {
  const usage = response?.usage;
  return {
    inputTokens: usage?.prompt_tokens ?? null,
    outputTokens: usage?.completion_tokens ?? null,
    totalTokens: usage?.total_tokens ?? null,
    cachedInputTokens: usage?.prompt_tokens_details?.cached_tokens ?? null,
    reasoningTokens: usage?.completion_tokens_details?.reasoning_tokens ?? null,
    finishReason: response?.choices?.[0]?.finish_reason ?? null,
  };
}
