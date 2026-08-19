import OpenAI from 'openai';
import fs from 'fs';

export class WhisperService {
  private static getClient() {
    return new OpenAI({
      apiKey: process.env.OPENAI_API_KEY,
    });
  }

  static async transcribeAudio(audioPath: string): Promise<string> {
    const openai = this.getClient();
    const audioStream = fs.createReadStream(audioPath);

    const response = await openai.audio.transcriptions.create({
      file: audioStream,
      model: 'whisper-1',
      response_format: 'text',
    });
    return response as unknown as string;
  }

  /**
   * Translates an audio file to English using OpenAI Whisper API
   */
  static async translateAudio(audioPath: string): Promise<string> {
    const openai = this.getClient();
    const audioStream = fs.createReadStream(audioPath);

    const response = await openai.audio.translations.create({
      file: audioStream,
      model: 'whisper-1',
      response_format: 'text',
    });
    return response as unknown as string;
  }

  /**
   * Transcribes the audio into its original language and translates it to English in parallel.
   */
  static async processAudio(audioPath: string): Promise<{ originalTranscript: string; englishTranscript: string }> {
    const [originalTranscript, englishTranscript] = await Promise.all([
      this.transcribeAudio(audioPath),
      this.translateAudio(audioPath),
    ]);
    return { originalTranscript, englishTranscript };
  }
}
