import OpenAI from 'openai';
import { plog, recordPipelineOperation, type PipelineStage } from './pipeline-log';

/**
 * 'chat-recovery' is the places-only second look that runs when the first
 * extraction returned fewer places than the evidence shows. It uses
 * OPENAI_RECOVERY_MODEL when set, otherwise the normal chat model.
 */
export type AITaskType = 'chat' | 'chat-recovery' | 'vision' | 'audio' | 'audio-translation';

export interface AIClientConfig {
  client: OpenAI;
  model: string;
  provider: 'groq' | 'openai';
  isGroq: boolean;
}

export interface AIUsageReport {
  inputTokens?: number | null;
  outputTokens?: number | null;
  totalTokens?: number | null;
  requestSummary?: Record<string, unknown>;
  resultSummary?: Record<string, unknown>;
}

export type AIUsageReporter = (usage: AIUsageReport) => void;

function stageForTask(task: AITaskType): PipelineStage {
  if (task === 'vision') return 'vision';
  if (task === 'audio' || task === 'audio-translation') return 'transcript';
  return 'model';
}

function envModel(name: string, fallback: string): string {
  return process.env[name]?.trim() || fallback;
}

function openAiConfig(task: AITaskType, apiKey: string): AIClientConfig {
  const model = task === 'audio' || task === 'audio-translation'
    ? envModel('OPENAI_AUDIO_MODEL', 'whisper-1')
    : task === 'vision'
      ? envModel('OPENAI_VISION_MODEL', 'gpt-4o')
      : task === 'chat-recovery'
        ? envModel('OPENAI_RECOVERY_MODEL', envModel('OPENAI_CHAT_MODEL', 'gpt-4o-mini'))
        : envModel('OPENAI_CHAT_MODEL', 'gpt-4o-mini');
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

export function getAIClient(task: AITaskType): AIClientConfig {
  return getAIClientConfigs(task)[0];
}

export function supportsTemperature(model: string): boolean {
  return !/^(o\d|gpt-5)/i.test(model.replace(/^openai\//, ''));
}

/**
 * Executes an AI task with automatic provider fallback in the order returned by
 * getAIClientConfigs. Rate limit (429) errors are retried with exponential backoff.
 */
export async function executeAICall<T>(
  task: AITaskType,
  fn: (config: AIClientConfig, reportUsage: AIUsageReporter) => Promise<T>
): Promise<T> {
  const configs = getAIClientConfigs(task);
  let lastError: any = null;

  for (let i = 0; i < configs.length; i++) {
    const config = configs[i];
    const maxRetries = 2;

    for (let attempt = 1; attempt <= maxRetries + 1; attempt++) {
      const startedAt = new Date();
      let usage: AIUsageReport = {};
      try {
        if (i > 0 || attempt > 1) {
          plog(stageForTask(task), 'AI provider call attempt', {
            task,
            provider: config.provider,
            model: config.model,
            attempt,
            providerIndex: i + 1,
          }, 'warn');
        }
        const result = await fn(config, (reported) => {
          usage = { ...usage, ...reported };
        });
        recordPipelineOperation({
          stage: stageForTask(task),
          operation: `ai_${task}`,
          provider: config.provider,
          model: config.model,
          attempt,
          isFallback: i > 0 || attempt > 1,
          startedAt,
          finishedAt: new Date(),
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
          totalTokens: usage.totalTokens,
          requestSummary: { task, ...(usage.requestSummary || {}) },
          resultSummary: usage.resultSummary,
        });
        return result;
      } catch (err: any) {
        lastError = err;
        const status = Number(err?.status ?? err?.statusCode);
        const msg = String(err?.message || err || '');
        const isRateLimit = status === 429 || /(?:rate limit|tpm|rpm|too many requests|429)/i.test(msg);

        recordPipelineOperation({
          stage: stageForTask(task),
          operation: `ai_${task}`,
          provider: config.provider,
          model: config.model,
          status: 'failed',
          attempt,
          isFallback: i > 0 || attempt > 1,
          startedAt,
          finishedAt: new Date(),
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
          totalTokens: usage.totalTokens,
          requestSummary: { task, ...(usage.requestSummary || {}) },
          error: err,
          retryable: attempt <= maxRetries || i < configs.length - 1,
        });

        if (isRateLimit && attempt <= maxRetries) {
          const msMatch = msg.match(/try again in (\d+)(ms|s)?/i);
          let delayMs = 1200;
          if (msMatch) {
            const val = parseInt(msMatch[1], 10);
            const unit = msMatch[2]?.toLowerCase();
            delayMs = unit === 's' ? val * 1000 : val;
            delayMs = Math.max(delayMs + 200, 800);
          } else {
            delayMs = attempt * 1000;
          }
          plog(stageForTask(task), `Rate limit (429) hit. Retrying in ${delayMs}ms (attempt ${attempt}/${maxRetries})`, {
            task,
            provider: config.provider,
            model: config.model,
            error: msg,
          }, 'warn');
          await new Promise((resolve) => setTimeout(resolve, delayMs));
          continue;
        }

        plog(stageForTask(task), 'AI provider failed', {
          task,
          provider: config.provider,
          model: config.model,
          attempt,
          error: err.message || String(err),
        }, i < configs.length - 1 ? 'warn' : 'error');
        break;
      }
    }
  }

  throw lastError || new Error(`All AI providers failed for task: ${task}`);
}
