import { NextResponse } from 'next/server';
import { getWebSessionFromCookies } from '@/lib/web-auth';

export const dynamic = 'force-dynamic';

export async function GET() {
  const session = await getWebSessionFromCookies();

  if (!session) {
    return NextResponse.json({
      authenticated: false,
      user: null,
    });
  }

  return NextResponse.json({
    authenticated: true,
    user: {
      email: session.email,
      role: session.role,
    },
  });
}
