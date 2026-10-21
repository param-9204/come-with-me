import { NextResponse } from 'next/server';
import {
  validateWebCredentials,
  createWebSessionToken,
  WEB_AUTH_COOKIE_NAME,
} from '@/lib/web-auth';

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  try {
    const body = await request.json().catch(() => ({}));
    const { email, password, rememberMe } = body;

    const validation = validateWebCredentials(email, password);
    if (!validation.valid || !validation.email) {
      return NextResponse.json(
        {
          success: false,
          error: validation.error || 'Invalid email or password.',
        },
        { status: 401 }
      );
    }

    const { token, maxAge } = await createWebSessionToken(
      validation.email,
      Boolean(rememberMe)
    );

    const response = NextResponse.json({
      success: true,
      message: 'Login successful',
      user: {
        email: validation.email,
        role: 'admin',
      },
    });

    response.cookies.set({
      name: WEB_AUTH_COOKIE_NAME,
      value: token,
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      path: '/',
      maxAge,
    });

    return response;
  } catch (error: any) {
    console.error('[Web Auth Login] Unexpected error:', error);
    return NextResponse.json(
      {
        success: false,
        error: 'An unexpected authentication error occurred.',
      },
      { status: 500 }
    );
  }
}
