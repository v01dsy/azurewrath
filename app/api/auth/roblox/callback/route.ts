import { NextRequest, NextResponse } from 'next/server';
import { cookies } from 'next/headers';

export async function GET(request: NextRequest) {
  const searchParams = request.nextUrl.searchParams;
  const code = searchParams.get('code');
  const state = searchParams.get('state');
  
  const cookieStore = await cookies();
  const storedState = cookieStore.get('oauth_state')?.value;
  
  console.log('Callback received - code:', code ? 'present' : 'missing');
  console.log('State match:', state === storedState);
  
  if (state !== storedState) {
    return NextResponse.redirect(new URL('/verify?error=invalid_state', request.url));
  }
  
  if (!code) {
    return NextResponse.redirect(new URL('/verify?error=no_code', request.url));
  }
  
  try {
    const clientId = process.env.ROBLOX_CLIENT_ID;
    const clientSecret = process.env.ROBLOX_CLIENT_SECRET;
    const redirectUri = process.env.ROBLOX_REDIRECT_URI;
    
    console.log('Env vars - clientId:', clientId ? 'set' : 'MISSING');
    console.log('Env vars - clientSecret:', clientSecret ? 'set' : 'MISSING');
    console.log('Env vars - redirectUri:', redirectUri || 'MISSING');
    
    const tokenResponse = await fetch('https://apis.roblox.com/oauth/v1/token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Authorization': `Basic ${Buffer.from(
          `${clientId}:${clientSecret}`
        ).toString('base64')}`,
      },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code: code,
        redirect_uri: redirectUri!,
      }),
    });
    
    console.log('Token response status:', tokenResponse.status);
    const tokenText = await tokenResponse.text();
    console.log('Token response body:', tokenText);
    
    if (!tokenResponse.ok) {
      throw new Error(`Token exchange failed: ${tokenResponse.status} - ${tokenText}`);
    }
    
    const tokens = JSON.parse(tokenText);
    
    const userInfoResponse = await fetch('https://apis.roblox.com/oauth/v1/userinfo', {
      headers: {
        'Authorization': `Bearer ${tokens.access_token}`,
      },
    });
    
    if (!userInfoResponse.ok) {
      throw new Error('Failed to get user info');
    }
    
    const userInfo = await userInfoResponse.json();
    
    console.log('Roblox User Info:', userInfo);
    
    return NextResponse.redirect(new URL('/verify?verified=true', request.url));
  } catch (error) {
    console.error('OAuth error:', error);
    return NextResponse.redirect(new URL('/verify?error=oauth_failed', request.url));
  }
}