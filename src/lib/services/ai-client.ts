import OpenAI from 'openai';

export type AITaskType = 'chat' | 'vision' | 'audio' | 'audio-translation';

export interface AIClientConfig {
  client: OpenAI;
  model: string;
  isGroq: boolean;
}

export function getAIClient(task: AITaskType): AIClientConfig {
  const openAiKey = process.env.OPENAI_API_KEY;
  const groqKey = process.env.GROQ_API_KEY;

  if (openAiKey) {
    let model = 'gpt-4o';
    if (task === 'vision') model = 'gpt-4o';
    if (task === 'audio' || task === 'audio-translation') model = 'whisper-1';

    return {
      client: new OpenAI({ apiKey: openAiKey }),
      model,
      isGroq: false,
    };
  } else if (groqKey) {
    let model = 'openai/gpt-oss-20b'; // fallback
    if (task === 'chat') model = 'openai/gpt-oss-20b';
    if (task === 'vision') model = 'openai/gpt-oss-20b'; // or llama-3.2-90b-vision-preview
    if (task === 'audio' || task === 'audio-translation') model = 'whisper-large-v3';

    return {
      client: new OpenAI({
        apiKey: groqKey,
        baseURL: 'https://api.groq.com/openai/v1',
      }),
      model,
      isGroq: true,
    };
  } else {
    throw new Error('No AI API key found. Please set either OPENAI_API_KEY or GROQ_API_KEY.');
  }
}
