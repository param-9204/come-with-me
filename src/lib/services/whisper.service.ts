import { getAIClient, executeAICall } from './ai-client';
import fs from 'fs';

export class WhisperService {
  static async transcribeAudioVerbose(audioPath: string): Promise<{ text: string; language: string }> {
    return executeAICall('audio', async ({ client, model }) => {
      const audioStream = fs.createReadStream(audioPath);
      const response = await client.audio.transcriptions.create({
        file: audioStream,
        model,
        response_format: 'verbose_json',
      });
      return response as unknown as { text: string; language: string };
    });
  }

  /**
   * Translates an audio file to English using Whisper API
   */
  static async translateAudio(audioPath: string): Promise<string> {
    return executeAICall('audio-translation', async ({ client, model }) => {
      const audioStream = fs.createReadStream(audioPath);
      const response = await client.audio.translations.create({
        file: audioStream,
        model,
        response_format: 'text',
      });
      return response as unknown as string;
    });
  }

  /**
   * Transcribes the audio into its original language and translates it to English ONLY if needed.
   */
  static async processAudio(audioPath: string): Promise<{ originalTranscript: string; englishTranscript: string }> {
    // 1. Transcribe the audio (this returns the original text AND detects the language)
    const original = await this.transcribeAudioVerbose(audioPath);
    const detectedLang = (original.language || '').toLowerCase();

    // 2. If it's already English, just use the same text! (Saves an API call & tokens)
    if (detectedLang === 'english' || detectedLang === 'en') {
      console.log('[Whisper] Detected English. Skipping translation API call.');
      return {
        originalTranscript: original.text,
        englishTranscript: original.text
      };
    }

    // 3. If it's NOT English, we make a 2nd API call to get the translation.
    console.log(`[Whisper] Detected ${detectedLang}. Calling translation API...`);
    const englishTranscript = await this.translateAudio(audioPath);

    return {
      originalTranscript: original.text,
      englishTranscript
    };
  }
}
