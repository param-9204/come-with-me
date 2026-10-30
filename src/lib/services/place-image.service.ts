import { supabaseAdmin } from '@/lib/supabase';
import { plog } from './pipeline-log';
import type { PlacePhotoInfo } from './location.service';

const BUCKET = 'place_photos';
const MAX_PHOTOS_PER_PLACE = 3;

export class PlaceImageService {
  private static bucketEnsured = false;

  private static async ensureBucket(): Promise<void> {
    if (this.bucketEnsured) return;
    try {
      const { data: buckets } = await supabaseAdmin.storage.listBuckets();
      const exists = (buckets || []).some((b) => b.name === BUCKET || b.id === BUCKET);
      if (!exists) {
        await supabaseAdmin.storage.createBucket(BUCKET, { public: true });
      }
      this.bucketEnsured = true;
    } catch (err: any) {
      // Non-fatal if bucket already exists or permissions handled in SQL
      this.bucketEnsured = true;
    }
  }

  /**
   * Downloads up to 3 photos strictly from Google Places API (New)
   * and uploads each JPEG binary stream to Supabase Storage in the public place_photos bucket.
   * Returns arrays of public URLs and author attributions.
   */
  static async uploadGooglePlacePhotos(params: {
    photos: PlacePhotoInfo[];
    placeId: string;
    apiKey: string;
  }): Promise<{ imageUrls: string[]; imageAttributions: string[] }> {
    const rawPhotos = Array.isArray(params.photos) ? params.photos.slice(0, MAX_PHOTOS_PER_PLACE) : [];
    if (!rawPhotos.length || !params.apiKey || !params.placeId) {
      return { imageUrls: [], imageAttributions: [] };
    }

    await this.ensureBucket();

    const imageUrls: string[] = [];
    const imageAttributions: string[] = [];

    for (let index = 0; index < rawPhotos.length; index++) {
      const photo = rawPhotos[index];
      if (!photo?.name) continue;

      try {
        const photoUrl = `https://places.googleapis.com/v1/${photo.name}/media?maxWidthPx=800&maxHeightPx=600&key=${params.apiKey}`;
        const res = await fetch(photoUrl, {
          redirect: 'follow',
          signal: AbortSignal.timeout(10000),
          headers: {
            'User-Agent': 'ComeWithMe-Scraper/1.0',
          },
        });

        if (!res.ok) {
          plog(
            'geocode',
            `Google photo download returned HTTP ${res.status} for photo ${index + 1}/${rawPhotos.length}`,
            { placeId: params.placeId, status: res.status, photoName: photo.name },
            'warn'
          );
          continue;
        }

        const contentType = res.headers.get('content-type') || 'image/jpeg';
        const arrayBuf = await res.arrayBuffer();
        const buffer = Buffer.from(arrayBuf);

        if (!buffer.length) {
          plog('geocode', `Empty buffer returned for Google photo ${photo.name}`, { placeId: params.placeId }, 'warn');
          continue;
        }

        const storagePath = `places/${params.placeId}_${index}.jpg`;
        const { error: uploadError } = await supabaseAdmin.storage
          .from(BUCKET)
          .upload(storagePath, buffer, {
            contentType,
            upsert: true,
          });

        if (uploadError) {
          plog(
            'db',
            `Failed to upload place photo to Supabase Storage: ${uploadError.message}`,
            { placeId: params.placeId, storagePath },
            'warn'
          );
          continue;
        }

        const { data } = supabaseAdmin.storage.from(BUCKET).getPublicUrl(storagePath);
        if (data?.publicUrl) {
          imageUrls.push(data.publicUrl);
          imageAttributions.push(photo.attribution?.trim() || 'Google Maps');
        }
      } catch (err: any) {
        plog(
          'geocode',
          `Error downloading/storing Google photo ${index + 1}: ${err.message}`,
          { placeId: params.placeId, error: err.message },
          'warn'
        );
      }
    }

    return { imageUrls, imageAttributions };
  }
}
