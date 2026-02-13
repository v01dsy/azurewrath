import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';

export async function GET() {
  const clientId = process.env.ROBLOX_CLIENT_ID;
  const redirectUri = process.env.ROBLOX_REDIRECT_URI;
  const state = Math.random().toString(36).substring(2, 15);
  
  // Store state in cookie for CSRF protection
  const cookieStore = await cookies();
  cookieStore.set('oauth_state', state, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    maxAge: 600, // 10 minutes
  });
  
  const authUrl = new URL('https://apis.roblox.com/oauth/v1/authorize');
  authUrl.searchParams.append('client_id', clientId!);
  authUrl.searchParams.append('redirect_uri', redirectUri!);
  authUrl.searchParams.append('scope', 'openid profile');
  authUrl.searchParams.append('response_type', 'code');
  authUrl.searchParams.append('state', state);
  
  return NextResponse.redirect(authUrl.toString());
}