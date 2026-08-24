import { supabaseAdmin } from '../supabase';
import { messaging } from '../firebase';

interface PushNotificationPayload {
  title: string;
  body: string;
  data?: Record<string, any>;
}

export class NotificationService {
  /**
   * Register a new device push token for a user.
   */
  static async registerToken(userId: string, token: string, platform?: string) {
    const { data, error } = await supabaseAdmin
      .from('push_tokens')
      .upsert(
        { user_id: userId, token, platform: platform || 'firebase' },
        { onConflict: 'user_id, token' }
      )
      .select('id')
      .single();

    if (error) {
      console.error('[NotificationService] Register token error:', error.message);
      throw error;
    }
    return data;
  }

  /**
   * Remove a device push token (e.g. on logout).
   */
  static async unregisterToken(userId: string, token: string) {
    const { error } = await supabaseAdmin
      .from('push_tokens')
      .delete()
      .eq('user_id', userId)
      .eq('token', token);

    if (error) {
      console.error('[NotificationService] Unregister token error:', error.message);
      throw error;
    }
  }

  /**
   * Send a push notification to all devices registered by a specific user.
   */
  static async sendToUser(userId: string, payload: PushNotificationPayload) {
    // 1. Fetch all tokens registered for the user
    const { data: deviceTokens, error } = await supabaseAdmin
      .from('push_tokens')
      .select('token, platform')
      .eq('user_id', userId);

    if (error || !deviceTokens || deviceTokens.length === 0) {
      console.log(`[NotificationService] No push tokens found for user: ${userId}`);
      return;
    }

    // 2. Map all tokens for Firebase
    const tokens = deviceTokens.map((d) => d.token);

    if (tokens.length > 0) {
      await this.sendViaFirebase(tokens, payload);
    }
  }

  /**
   * Sends push notifications using Firebase Cloud Messaging (FCM)
   */
  private static async sendViaFirebase(tokens: string[], payload: PushNotificationPayload) {
    if (!messaging) {
      console.error('[NotificationService] Firebase Messaging is not initialized. Push skipped.');
      return;
    }

    try {
      console.log(`[NotificationService] Sending push to ${tokens.length} FCM devices...`);
      const response = await messaging.sendEachForMulticast({
        tokens: tokens,
        notification: {
          title: payload.title,
          body: payload.body,
        },
        data: payload.data ? Object.keys(payload.data).reduce((acc, key) => {
          acc[key] = String(payload.data![key]);
          return acc;
        }, {} as Record<string, string>) : undefined,
      });

      console.log(
        `[NotificationService] Push notifications successfully dispatched via Firebase. Success: ${response.successCount}, Failure: ${response.failureCount}`
      );

      // Clean up stale or invalid tokens returned by FCM response
      if (response.failureCount > 0) {
        const tokensToRemove: string[] = [];
        response.responses.forEach((resp: any, idx: number) => {
          if (!resp.success && resp.error) {
            const errCode = resp.error.code;
            if (
              errCode === 'messaging/registration-token-not-registered' ||
              errCode === 'messaging/invalid-registration-token'
            ) {
              tokensToRemove.push(tokens[idx]);
            }
          }
        });

        if (tokensToRemove.length > 0) {
          console.log(`[NotificationService] Removing ${tokensToRemove.length} expired/invalid FCM tokens...`);
          await supabaseAdmin
            .from('push_tokens')
            .delete()
            .in('token', tokensToRemove);
        }
      }
    } catch (err: any) {
      console.error('[NotificationService] Failed to send push via Firebase:', err.message);
    }
  }
}
