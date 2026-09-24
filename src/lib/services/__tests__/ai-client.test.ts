import { afterEach, describe, expect, it } from 'vitest';
import { getAIClientConfigs } from '../ai-client';

const saved = { ...process.env };

afterEach(() => {
  process.env = { ...saved };
});

describe('model per task', () => {
  it('uses the normal chat model for the second look unless OPENAI_RECOVERY_MODEL is set', () => {
    process.env.OPENAI_API_KEY = 'sk-test';
    delete process.env.GROQ_API_KEY;
    delete process.env.OPENAI_CHAT_MODEL;
    delete process.env.OPENAI_RECOVERY_MODEL;
    expect(getAIClientConfigs('chat-recovery')[0].model).toBe('gpt-4o-mini');

    process.env.OPENAI_CHAT_MODEL = 'gpt-4o-mini';
    process.env.OPENAI_RECOVERY_MODEL = 'gpt-4o';
    expect(getAIClientConfigs('chat-recovery')[0].model).toBe('gpt-4o');
    expect(getAIClientConfigs('chat')[0].model).toBe('gpt-4o-mini');
  });
});
