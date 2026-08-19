import { NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';
import { supabaseAdmin } from '@/lib/supabase';
import { MediaService } from '@/lib/services/media.service';
import { WhisperService } from '@/lib/services/whisper.service';
import { S3Service } from '@/lib/services/s3.service';

export async function POST(request: Request) {
  let tempVideoPath = '';
  let tempAudioPath = '';

  try {
    const body = await request.json();
    const { videoUrl } = body;

    if (!videoUrl || typeof videoUrl !== 'string') {
      return NextResponse.json({ error: 'Missing required field: videoUrl' }, { status: 400 });
    }

    console.log(`[API Transcribe] Starting transcription for video URL: ${videoUrl}`);

    // 1. Download video
    tempVideoPath = await MediaService.downloadVideo(videoUrl);
    if (!tempVideoPath) {
      throw new Error('Failed to download video file.');
    }

    // 2. Extract audio
    tempAudioPath = await MediaService.extractAudio(tempVideoPath);
    if (!tempAudioPath) {
      throw new Error('Failed to extract audio from video.');
    }

    // 3. Transcribe and translate with Whisper
    const whisperResult = await WhisperService.processAudio(tempAudioPath);
    if (!whisperResult) {
      throw new Error('Whisper transcription failed.');
    }

    const transcript = `Original Transcript:\n${whisperResult.originalTranscript}\n\nEnglish Translation:\n${whisperResult.englishTranscript}`;

    // 4. Upload Audio to AWS S3 & save to DB (similar to the original route)
    let audioUploadResultData: any = null;
    const fileStats = fs.statSync(/*turbopackIgnore: true*/ tempAudioPath);
    const fileName = path.basename(tempAudioPath);
    const audioUuid = uuidv4();

    // Try uploading to S3
    if (process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY && process.env.AWS_S3_BUCKET_NAME) {
      try {
        const fileBuffer = fs.readFileSync(/*turbopackIgnore: true*/ tempAudioPath);
        const s3Url = await S3Service.uploadAudio(fileBuffer, fileName, 'audio/mpeg');

        const { data: dbData, error: dbError } = await supabaseAdmin
          .from('audio_uploads')
          .insert({
            social_post_id: null, // to be updated in the analyze step
            file_name: fileName,
            storage_path: `uploads/${fileName}`,
            public_url: s3Url,
            mime_type: 'audio/mpeg',
            size_bytes: fileStats.size,
          })
          .select('id, file_name, size_bytes, public_url')
          .single();

        if (!dbError && dbData) {
          audioUploadResultData = {
            id: dbData.id,
            fileName: dbData.file_name,
            sizeBytes: dbData.size_bytes,
            publicUrl: dbData.public_url,
          };
          console.log('[API Transcribe] Audio saved to S3 and registered in DB:', dbData.id);
        } else {
          console.warn('[API Transcribe] S3 DB registration failed, using local fallback:', dbError?.message);
        }
      } catch (err: any) {
        console.error('[API Transcribe] AWS S3 upload failed, using local fallback:', err.message);
      }
    }

    // Fallback to local copy
    if (!audioUploadResultData) {
      try {
        const publicAudioDir = path.join(process.cwd(), 'public', 'audio');
        if (!fs.existsSync(publicAudioDir)) {
          fs.mkdirSync(publicAudioDir, { recursive: true });
        }
        const localFileName = `${audioUuid}.mp3`;
        const localFilePath = path.join(publicAudioDir, localFileName);
        fs.copyFileSync(tempAudioPath, localFilePath);
        const localPublicUrl = `/audio/${localFileName}`;

        audioUploadResultData = {
          id: audioUuid, // virtual or local id
          fileName: fileName,
          sizeBytes: fileStats.size,
          publicUrl: localPublicUrl,
        };
        console.log('[API Transcribe] Audio saved to local public folder:', localPublicUrl);
      } catch (err: any) {
        console.error('[API Transcribe] Local fallback copy failed:', err.message);
      }
    }

    // 5. Cleanup
    MediaService.cleanupFiles([tempVideoPath, tempAudioPath]);

    return NextResponse.json({
      success: true,
      transcript,
      audioUpload: audioUploadResultData,
    });

  } catch (error: any) {
    console.error('[API Transcribe] Error:', error);
    
    // Attempt cleanup on error
    try {
      MediaService.cleanupFiles([tempVideoPath, tempAudioPath].filter(Boolean));
    } catch (cleanupErr) {
      console.error('[API Transcribe] Cleanup error:', cleanupErr);
    }

    return NextResponse.json({
      success: false,
      error: error.message || 'Transcription failed',
    }, { status: 500 });
  }
}
