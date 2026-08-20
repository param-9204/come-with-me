import { NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase';
import { v4 as uuidv4 } from 'uuid';
import fs from 'fs';
import path from 'path';
import { S3Service } from '@/lib/services/s3.service';
import { getAuthUser } from '@/lib/auth';

export async function POST(request: Request) {
  try {
    const user = await getAuthUser(request);
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized. Authenticated session required.' }, { status: 401 });
    }

    const formData = await request.formData();
    const file = formData.get('file') as File | null;
    const socialPostId = formData.get('socialPostId') as string | null;

    if (!file) {
      return NextResponse.json({ error: 'No file uploaded' }, { status: 400 });
    }

    // Validate size (max 50MB)
    const MAX_SIZE = 50 * 1024 * 1024;
    if (file.size > MAX_SIZE) {
      return NextResponse.json({ error: 'File size exceeds 50MB limit' }, { status: 400 });
    }

    // Validate mime type
    const allowedMimeTypes = [
      'audio/mpeg',
      'audio/mp3',
      'audio/wav',
      'audio/wave',
      'audio/x-wav',
      'audio/x-pn-wav',
      'audio/m4a',
      'audio/x-m4a',
      'audio/ogg',
      'audio/webm',
      'audio/aac',
      'audio/x-aac',
    ];
    if (!allowedMimeTypes.includes(file.type) && !file.name.match(/\.(mp3|wav|m4a|ogg|webm|aac)$/i)) {
      return NextResponse.json(
        { error: `Invalid file type: ${file.type}. Allowed: mp3, wav, m4a, ogg, webm, aac` },
        { status: 400 }
      );
    }

    // Convert file to ArrayBuffer
    const arrayBuffer = await file.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    // Create unique filename path
    const fileExt = file.name.split('.').pop() || 'mp3';
    const audioUuid = uuidv4();

    const bucketName = 'audio_uploads';
    let responseData: any = null;

    // 1. Upload to AWS S3 if configured
    if (process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY && process.env.AWS_S3_BUCKET_NAME) {
      try {
        const s3Url = await S3Service.uploadAudio(buffer, file.name, file.type);

        // Insert entry in DB
        const { data: dbData, error: dbError } = await supabaseAdmin
          .from('audio_uploads')
          .insert({
            social_post_id: socialPostId || null,
            file_name: file.name,
            storage_path: `uploads/${file.name}`,
            public_url: s3Url,
            mime_type: file.type,
            size_bytes: file.size,
          })
          .select('id')
          .single();

        if (!dbError && dbData) {
          responseData = {
            success: true,
            id: dbData.id,
            fileName: file.name,
            publicUrl: s3Url,
            sizeBytes: file.size,
            mimeType: file.type,
          };
        } else {
          console.warn('[Upload-Audio] DB registration failed:', dbError?.message);
        }
      } catch (err: any) {
        console.error('[Upload-Audio] AWS S3 upload failed, falling back:', err.message);
      }
    }

    // 2. Safeguard fallback to local if AWS S3 is unavailable or failed
    if (!responseData) {
      const publicAudioDir = path.join(process.cwd(), 'public', 'audio');
      if (!fs.existsSync(/*turbopackIgnore: true*/ publicAudioDir)) {
        fs.mkdirSync(/*turbopackIgnore: true*/ publicAudioDir, { recursive: true });
      }
      const localFileName = `${audioUuid}.${fileExt}`;
      const localFilePath = path.join(publicAudioDir, localFileName);
      fs.writeFileSync(/*turbopackIgnore: true*/ localFilePath, buffer);
      const localPublicUrl = `/audio/${localFileName}`;

      responseData = {
        success: true,
        id: audioUuid,
        fileName: file.name,
        publicUrl: localPublicUrl,
        sizeBytes: file.size,
        mimeType: file.type,
      };
    }

    return NextResponse.json(responseData);
  } catch (err: any) {
    console.error('[Upload-Audio] Unhandled exception:', err);
    return NextResponse.json({ error: err.message || 'Internal server error' }, { status: 500 });
  }
}
