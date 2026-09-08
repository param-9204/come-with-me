import { NextResponse } from 'next/server';
import { getAuthUser } from '@/lib/auth';
import { S3Service } from '@/lib/services/s3.service';

/**
 * POST /api/upload/avatar
 *
 * Accepts multipart/form-data with an "file" or "image" field.
 * Uploads the image to AWS S3 under avatars/ directory and returns the S3 URL.
 */
export async function POST(request: Request) {
  try {
    const user = await getAuthUser(request);
    if (!user) {
      return NextResponse.json(
        { error: 'Unauthorized. Authenticated session required.' },
        { status: 401 }
      );
    }

    const formData = await request.formData();
    const file = (formData.get('file') || formData.get('image')) as File | null;

    if (!file) {
      return NextResponse.json(
        { error: 'No file provided in form-data field "file" or "image"' },
        { status: 400 }
      );
    }

    // Validate MIME type (must be image)
    if (!file.type.startsWith('image/')) {
      return NextResponse.json(
        { error: 'Invalid file type. File must be an image (jpg, png, webp, etc.)' },
        { status: 400 }
      );
    }

    const arrayBuffer = await file.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    const s3Url = await S3Service.uploadFile(
      buffer,
      file.name || 'avatar.jpg',
      file.type || 'image/jpeg',
      "avatars"
    );

    return NextResponse.json({
      success: true,
      message: 'Profile image uploaded to S3 successfully',
      url: s3Url,
    });
  } catch (error: any) {
    console.error('[Upload Avatar API] Error:', error);
    return NextResponse.json(
      { error: error.message || 'Failed to upload profile image to S3' },
      { status: 500 }
    );
  }
}
