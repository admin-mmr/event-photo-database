/**
 * TokenService — verifies Google Identity Services ID tokens server-side.
 *
 * After the client-side GIS button returns a credential JWT, the browser calls
 * serverVerifyGoogleToken(idToken). This service validates the token by calling
 * Google's public tokeninfo endpoint (no client secret required).
 *
 * Security note: we verify:
 *   - HTTP 200 from Google's tokeninfo endpoint
 *   - email_verified === true
 *   - Token has not expired
 *   - aud matches our expected client ID (optional, checked if GOOGLE_CLIENT_ID is set)
 */

import { ResultStatus } from '../types/enums';
import { ServiceResult } from '../types/responses';

/* global UrlFetchApp, PropertiesService */

interface TokenInfoResponse {
  email?:          string;
  email_verified?: string | boolean;
  aud?:            string;
  exp?:            string;
  error?:          string;
  error_description?: string;
}

/**
 * Verifies a Google ID token and returns the verified email on success.
 *
 * Uses the tokeninfo endpoint — no client secret needed for validation.
 * Round-trip to Google adds ~200-400 ms; acceptable for a one-time login.
 */
export function verifyGoogleIdToken(idToken: string): ServiceResult<{ email: string }> {
  if (!idToken || idToken.trim() === '') {
    return { status: ResultStatus.ERROR, message: 'No ID token provided.' };
  }

  let response: GoogleAppsScript.URL_Fetch.HTTPResponse;
  try {
    response = UrlFetchApp.fetch(
      `https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(idToken)}`,
      { muteHttpExceptions: true }
    );
  } catch (err) {
    return {
      status:  ResultStatus.ERROR,
      message: `Token verification network error: ${String(err)}`,
    };
  }

  const httpCode = response.getResponseCode();
  let payload: TokenInfoResponse;
  try {
    payload = JSON.parse(response.getContentText()) as TokenInfoResponse;
  } catch {
    return { status: ResultStatus.ERROR, message: `Token response unparseable (HTTP ${httpCode})` };
  }

  if (httpCode !== 200 || payload.error) {
    return {
      status:  ResultStatus.ERROR,
      message: `Token rejected by Google: ${payload.error_description ?? payload.error ?? `HTTP ${httpCode}`}`,
    };
  }

  if (!payload.email) {
    return { status: ResultStatus.ERROR, message: 'Token contains no email claim.' };
  }

  const verified = payload.email_verified === true || payload.email_verified === 'true';
  if (!verified) {
    return { status: ResultStatus.ERROR, message: 'Email address is not verified by Google.' };
  }

  // Expiry check
  if (payload.exp) {
    const expSecs = parseInt(String(payload.exp), 10);
    const nowSecs = Math.floor(Date.now() / 1000);
    if (expSecs < nowSecs) {
      return { status: ResultStatus.ERROR, message: 'ID token has expired. Please sign in again.' };
    }
  }

  // Optional: verify the token was issued for our client ID
  const expectedClientId = PropertiesService.getScriptProperties().getProperty('GOOGLE_CLIENT_ID');
  if (expectedClientId && payload.aud && payload.aud !== expectedClientId) {
    return {
      status:  ResultStatus.ERROR,
      message: 'Token audience does not match this application.',
    };
  }

  return {
    status:  ResultStatus.SUCCESS,
    message: 'Token verified',
    data:    { email: payload.email.trim().toLowerCase() },
  };
}

/**
 * Exchanges an OAuth 2.0 authorization code for an ID token, then verifies
 * and returns the email address from it.
 *
 * Used by the Authorization Code flow (redirect-based login). Requires
 * GOOGLE_CLIENT_SECRET in Script Properties.
 *
 * @param code        The authorization code from the OAuth redirect URL
 * @param redirectUri The exact redirect_uri used when initiating the flow
 */
export function exchangeOAuthCode(
  code: string,
  redirectUri: string
): ServiceResult<{ email: string }> {
  if (!code) {
    return { status: ResultStatus.ERROR, message: 'No authorization code provided.' };
  }

  const props = PropertiesService.getScriptProperties();
  const clientId     = props.getProperty('GOOGLE_CLIENT_ID')     ?? '';
  const clientSecret = props.getProperty('GOOGLE_CLIENT_SECRET') ?? '';

  if (!clientId || !clientSecret) {
    return {
      status:  ResultStatus.ERROR,
      message: 'GOOGLE_CLIENT_ID or GOOGLE_CLIENT_SECRET not configured in Script Properties.',
    };
  }

  let tokenResponse: GoogleAppsScript.URL_Fetch.HTTPResponse;
  try {
    tokenResponse = UrlFetchApp.fetch('https://oauth2.googleapis.com/token', {
      method:  'post',
      payload: {
        code,
        client_id:     clientId,
        client_secret: clientSecret,
        redirect_uri:  redirectUri,
        grant_type:    'authorization_code',
      },
      muteHttpExceptions: true,
    });
  } catch (err) {
    return {
      status:  ResultStatus.ERROR,
      message: `Token exchange network error: ${String(err)}`,
    };
  }

  const httpCode = tokenResponse.getResponseCode();
  let tokenData: { id_token?: string; error?: string; error_description?: string };
  try {
    tokenData = JSON.parse(tokenResponse.getContentText()) as typeof tokenData;
  } catch {
    return {
      status:  ResultStatus.ERROR,
      message: `Token exchange response unparseable (HTTP ${httpCode})`,
    };
  }

  if (httpCode !== 200 || tokenData.error) {
    return {
      status:  ResultStatus.ERROR,
      message: `Token exchange failed: ${tokenData.error_description ?? tokenData.error ?? `HTTP ${httpCode}`}`,
    };
  }

  if (!tokenData.id_token) {
    return { status: ResultStatus.ERROR, message: 'Token exchange response contained no id_token.' };
  }

  return verifyGoogleIdToken(tokenData.id_token);
}
