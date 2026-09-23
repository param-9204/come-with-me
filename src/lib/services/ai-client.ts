import OpenAI from 'openai';

export type AITaskType = 'chat' | 'vision' | 'audio' | 'audio-translation';

export interface AIClientConfig {
  client: OpenAI;
  model: string;
  provider: 'groq' | 'openai';
  isGroq: boolean;
}

function envModel(name: string, fallback: string): string {
  return process.env[name]?.trim() || fallback;
}

function openAiConfig(task: AITaskType, apiKey: string): AIClientConfig {
  const model = task === 'audio' || task === 'audio-translation'
    // whisper-1 is used because verbose_json segments (timestamps, no-speech
    // probability) are required for evidence alignment and hallucination filtering.
    ? envModel('OPENAI_AUDIO_MODEL', 'whisper-1')
    : task === 'vision'
      ? envModel('OPENAI_VISION_MODEL', 'gpt-4o')
      : envModel('OPENAI_CHAT_MODEL', 'gpt-4o');
  return { client: new OpenAI({ apiKey }), model, provider: 'openai', isGroq: false };
}

function groqConfig(task: AITaskType, apiKey: string): AIClientConfig {
  const model = task === 'audio' || task === 'audio-translation'
    ? envModel('GROQ_AUDIO_MODEL', 'whisper-large-v3')
    : envModel('GROQ_CHAT_MODEL', 'openai/gpt-oss-20b');
  return {
    client: new OpenAI({ apiKey, baseURL: 'https://api.groq.com/openai/v1' }),
    model,
    provider: 'groq',
    isGroq: true,
  };
}

/**
 * Provider order per task:
 * - chat: OpenAI first, Groq fallback.
 * - audio: Groq whisper-large-v3 first when configured (lower per-minute price),
 *   OpenAI whisper-1 fallback.
 * - vision: OpenAI only. The configured Groq chat model is text-only, so a Groq
 *   "fallback" for images would always fail.
 */
export function getAIClientConfigs(task: AITaskType): AIClientConfig[] {
  const groqKey = process.env.GROQ_API_KEY?.trim();
  const openAiKey = process.env.OPENAI_API_KEY?.trim();
  const hasOpenAi = !!openAiKey && openAiKey !== 'your-openai-api-key';
  const hasGroq = !!groqKey && groqKey !== 'your-groq-api-key';

  const openAi = hasOpenAi ? openAiConfig(task, openAiKey!) : null;
  const groq = hasGroq && task !== 'vision' ? groqConfig(task, groqKey!) : null;

  const ordered = task === 'audio' || task === 'audio-translation' ? [groq, openAi] : [openAi, groq];
  const configs = ordered.filter((config): config is AIClientConfig => config !== null);

  if (configs.length === 0) {
    throw new Error(
      task === 'vision'
        ? 'Vision requires OPENAI_API_KEY.'
        : 'No AI API key found. Please set GROQ_API_KEY or OPENAI_API_KEY in .env.'
    );
  }
  return configs;
}

/** Legacy single-client accessor (returns the first provider for the task). */
export function getAIClient(task: AITaskType): AIClientConfig {
  return getAIClientConfigs(task)[0];
}

/** Reasoning-model families reject `temperature`; classic chat models accept it. */
export function supportsTemperature(model: string): boolean {
  return !/^(o\d|gpt-5)/i.test(model.replace(/^openai\//, ''));
}

/**
 * Executes an AI task with automatic provider fallback in the order returned by
 * getAIClientConfigs. Any provider error (rate limit, validation, network)
 * moves on to the next provider.
 */
export async function executeAICall<T>(
  task: AITaskType,
  fn: (config: AIClientConfig) => Promise<T>
): Promise<T> {
  const configs = getAIClientConfigs(task);
  let lastError: any = null;

  for (let i = 0; i < configs.length; i++) {
    const config = configs[i];
    try {
      if (i > 0) {
        console.log(`[AI Client] Falling back to provider #${i + 1}: ${config.provider} (${config.model})...`);
      }
      return await fn(config);
    } catch (err: any) {
      lastError = err;
      console.warn(
        `[AI Client] Provider ${config.provider} (${config.model}) failed for ${task}:`,
        err.message || err
      );
    }
  }

  throw lastError || new Error(`All AI providers failed for task: ${task}`);
}
