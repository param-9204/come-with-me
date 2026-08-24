import { Webhook } from 'svix';
import { headers } from 'next/headers';
import type { WebhookEvent } from '@clerk/backend';
import { supabaseAdmin } from '@/lib/supabase';
import { v5 as uuidv5 } from 'uuid';

const CLERK_UUID_NAMESPACE = '1b671a64-40d5-491e-99b0-da01ff1f3341';

export async function POST(req: Request) {
  const WEBHOOK_SECRET = process.env.CLERK_WEBHOOK_SECRET;

  if (!WEBHOOK_SECRET) {
    console.error('[Clerk Webhook] Error: Missing CLERK_WEBHOOK_SECRET environment variable');
    return new Response('Error: Missing CLERK_WEBHOOK_SECRET', { status: 500 });
  }

  // 1. Get headers for signature verification
  const headerPayload = await headers();
  const svix_id = headerPayload.get('svix-id');
  const svix_timestamp = headerPayload.get('svix-timestamp');
  const svix_signature = headerPayload.get('svix-signature');

  if (!svix_id || !svix_timestamp || !svix_signature) {
    console.error('[Clerk Webhook] Error: Missing Svix signature headers');
    return new Response('Error: Missing svix headers', { status: 400 });
  }

  // 2. Get the request body
  const payload = await req.json();
  const body = JSON.stringify(payload);

  // 3. Verify signature
  const wh = new Webhook(WEBHOOK_SECRET);
  let evt: WebhookEvent;

  try {
    evt = wh.verify(body, {
      'svix-id': svix_id,
      'svix-timestamp': svix_timestamp,
      'svix-signature': svix_signature,
    }) as WebhookEvent;
  } catch (err: any) {
    console.error('[Clerk Webhook] Error: Signature verification failed:', err.message);
    return new Response('Error: Verification failed', { status: 400 });
  }

  // 4. Handle events
  const eventType = evt.type;
  console.log(`[Clerk Webhook] Processing event type: ${eventType}`);

  try {
    if (eventType === 'user.created') {
      const { id, email_addresses, first_name, last_name, phone_numbers } = evt.data;

      const clerkId = id;
      const email = email_addresses?.[0]?.email_address || null;
      const firstName = first_name || '';
      const lastName = last_name || '';
      const fullName = [firstName, lastName].filter(Boolean).join(' ') || 'Explorer';
      const phone = phone_numbers?.[0]?.phone_number || null;

      // Compute deterministic UUID v5
      const userUuid = uuidv5(clerkId, CLERK_UUID_NAMESPACE);
      console.log(`[Clerk Webhook] Creating user mapping: Clerk ID ${clerkId} -> UUID ${userUuid}`);

      // Step A: Create the user in Supabase auth.users to preserve foreign key constraints
      try {
        const { error: authError } = await supabaseAdmin.auth.admin.createUser({
          id: userUuid,
          email: email || undefined,
          email_confirm: true,
          user_metadata: { clerk_id: clerkId, full_name: fullName },
        });

        if (authError) {
          // If the user already exists in auth.users, log it but don't crash
          if (authError.message.includes('already exists')) {
            console.log('[Clerk Webhook] User already exists in auth.users, proceeding to profile sync');
          } else {
            console.warn('[Clerk Webhook] Supabase Auth creation warning:', authError.message);
          }
        }
      } catch (authErr: any) {
        console.error('[Clerk Webhook] Supabase Auth creation failed:', authErr.message);
      }

      // Step B: Upsert the user profile in public.profiles directly to guarantee synchronization
      const { error: profileError } = await supabaseAdmin
        .from('profiles')
        .upsert({
          id: userUuid,
          display_name: fullName,
          phone: phone,
        });

      if (profileError) {
        console.error('[Clerk Webhook] Profile sync failed:', profileError.message);
        return new Response(`Profile sync error: ${profileError.message}`, { status: 500 });
      }

      console.log(`[Clerk Webhook] Successfully created user and synced profile for: ${email}`);
    }

    if (eventType === 'user.updated') {
      const { id, first_name, last_name, phone_numbers } = evt.data;

      const clerkId = id;
      const firstName = first_name || '';
      const lastName = last_name || '';
      const fullName = [firstName, lastName].filter(Boolean).join(' ') || 'Explorer';
      const phone = phone_numbers?.[0]?.phone_number || null;

      // Compute deterministic UUID v5
      const userUuid = uuidv5(clerkId, CLERK_UUID_NAMESPACE);
      console.log(`[Clerk Webhook] Updating user profile: Clerk ID ${clerkId} -> UUID ${userUuid}`);

      // Update public.profiles table
      const { error: updateError } = await supabaseAdmin
        .from('profiles')
        .update({
          display_name: fullName,
          phone: phone,
        })
        .eq('id', userUuid);

      if (updateError) {
        console.error('[Clerk Webhook] Profile update failed:', updateError.message);
        return new Response(`Profile update error: ${updateError.message}`, { status: 500 });
      }

      console.log(`[Clerk Webhook] Successfully updated profile for Clerk ID: ${clerkId}`);
    }

    if (eventType === 'user.deleted') {
      const { id } = evt.data;
      if (!id) {
        return new Response('Error: Missing user ID', { status: 400 });
      }

      const clerkId = id;
      const userUuid = uuidv5(clerkId, CLERK_UUID_NAMESPACE);
      console.log(`[Clerk Webhook] Deleting user: Clerk ID ${clerkId} -> UUID ${userUuid}`);

      // Delete from Supabase Auth (cascade deletes profile and associated records)
      const { error: deleteError } = await supabaseAdmin.auth.admin.deleteUser(userUuid);

      if (deleteError) {
        console.error('[Clerk Webhook] User deletion failed:', deleteError.message);
        return new Response(`Deletion error: ${deleteError.message}`, { status: 500 });
      }

      console.log(`[Clerk Webhook] Successfully deleted user with UUID: ${userUuid}`);
    }

    return new Response('Webhook processed successfully', { status: 200 });
  } catch (error: any) {
    console.error('[Clerk Webhook] Unhandled exception processing webhook:', error.message);
    return new Response('Internal Server Error', { status: 500 });
  }
}
