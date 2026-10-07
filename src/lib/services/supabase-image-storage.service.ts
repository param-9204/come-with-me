import { v4 as uuidv4 } from 'uuid';
import { supabaseAdmin } from '@/lib/supabase';

const BUCKET = 'image_uploads';

function safeFileName(name: string): string {
  const cleaned = name.replace(/[^a-zA-Z0-9._-]/g, '_').slice(-120);
  return cleaned || 'image';
}

export class SupabaseImageStorageService {
  static async upload(file: File, userId: string): Promise<{ storagePath: string; publicUrl: string }> {
    const storagePath = `${userId}/${uuidv4()}_${safeFileName(file.name)}`;
    const { error } = await supabaseAdmin.storage
      .from(BUCKET)
      .upload(storagePath, Buffer.from(await file.arrayBuffer()), {
        contentType: file.type,
        upsert: false,
      });
    if (error) throw new Error(`Image storage upload failed: ${error.message}`);

    const { data } = supabaseAdmin.storage.from(BUCKET).getPublicUrl(storagePath);
    return { storagePath, publicUrl: data.publicUrl };
  }

  static async remove(storagePaths: string[]): Promise<void> {
    if (!storagePaths.length) return;
    const { error } = await supabaseAdmin.storage.from(BUCKET).remove(storagePaths);
    if (error) console.warn('[Image upload] Failed to remove orphaned storage files:', error.message);
  }
}
