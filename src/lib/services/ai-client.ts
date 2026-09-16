import OpenAI from 'openai';

export type AITaskType = 'chat' | 'vision' | 'audio' | 'audio-translation';

export interface AIClientConfig {
  client: OpenAI;
  model: string;
  provider: 'groq' | 'openai';
  isGroq: boolean;
}

export function getAIClientConfigs(task: AITaskType): AIClientConfig[] {
  const groqKey = process.env.GROQ_API_KEY?.trim();
  const openAiKey = process.env.OPENAI_API_KEY?.trim();

  const configs: AIClientConfig[] = [];

  // Priority #1: OpenAI key (if available)
  if (openAiKey && openAiKey !== 'your-openai-api-key') {
    let model = 'gpt-4o';
    if (task === 'chat') model = 'gpt-4o';
    if (task === 'vision') model = 'gpt-4o';
    if (task === 'audio' || task === 'audio-translation') model = 'whisper-1';

    configs.push({
      client: new OpenAI({ apiKey: openAiKey }),
      model,
      provider: 'openai',
      isGroq: false,
    });
  }

  // Priority #2: Groq key (if available) (acts as fallback when OpenAI key is also present)
  if (groqKey && groqKey !== 'your-groq-api-key') {
    let model = 'openai/gpt-oss-20b';
    if (task === 'chat') model = 'openai/gpt-oss-20b';
    if (task === 'vision') model = 'openai/gpt-oss-20b';
    if (task === 'audio' || task === 'audio-translation') model = 'whisper-large-v3';

    configs.push({
      client: new OpenAI({
        apiKey: groqKey,
        baseURL: 'https://api.groq.com/openai/v1',
      }),
      model,
      provider: 'groq',
      isGroq: true,
    });
  }

  if (configs.length === 0) {
    throw new Error('No AI API key found. Please set GROQ_API_KEY or OPENAI_API_KEY in .env.');
  }

  return configs;
}

/** Legacy single-client accessor (returns first available config, i.e. Groq if available else OpenAI). */
export function getAIClient(task: AITaskType): AIClientConfig {
  return getAIClientConfigs(task)[0];
}

/**
 * Executes an AI task with automatic fallback.
 * If both GROQ_API_KEY and OPENAI_API_KEY are present, tries Groq first.
 * If Groq encounters any rate limit, token limit, validation, or network error,
 * it automatically retries with OpenAI.
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
