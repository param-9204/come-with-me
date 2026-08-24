import { NextResponse } from 'next/server';
import { getAuthUser } from '@/lib/auth';
import { NotificationService } from '@/lib/services/notification.service';

/**
 * POST /api/notifications/register
 * 
 * Body:
 *   token    : string (e.g. ExponentPushToken[xxx])
 *   platform : 'expo' | 'ios' | 'android'
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

    let body;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
    }

    const { token, platform } = body;

    if (!token) {
      return NextResponse.json(
        { error: 'Missing required field: token' },
        { status: 400 }
      );
    }

    await NotificationService.registerToken(user.id, token, platform);

    return NextResponse.json({
      success: true,
      message: 'Mobile push token registered successfully',
    });
  } catch (error: any) {
    console.error('[Notification Register API] Error:', error.message);
    return NextResponse.json(
      { error: error.message || 'Internal server error' },
      { status: 500 }
    );
  }
}

/**
 * DELETE /api/notifications/register
 * 
 * Body:
 *   token : string (Unregister this token on logout)
 */
export async function DELETE(request: Request) {
  try {
    const user = await getAuthUser(request);
    if (!user) {
      return NextResponse.json(
        { error: 'Unauthorized. Authenticated session required.' },
        { status: 401 }
      );
    }

    let body;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
    }

    const { token } = body;

    if (!token) {
      return NextResponse.json(
        { error: 'Missing required field: token' },
        { status: 400 }
      );
    }

    await NotificationService.unregisterToken(user.id, token);

    return NextResponse.json({
      success: true,
      message: 'Mobile push token unregistered successfully',
    });
  } catch (error: any) {
    console.error('[Notification Unregister API] Error:', error.message);
    return NextResponse.json(
      { error: error.message || 'Internal server error' },
      { status: 500 }
    );
  }
}
