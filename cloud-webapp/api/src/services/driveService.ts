/**
 * driveService.ts — read an event's Drive folder (dev plan M1.2).
 *
 * Auth = keyless domain-wide delegation, the verified G1 pattern (runbook
 * §G1): sign a JWT as the DWD-enabled SA (indexer-runtime@) with
 * `sub=<workspace user>`, exchange it for a Drive access token. No SA keys.
 *
 * IAM prerequisite (one-time): the api's runtime SA needs
 * roles/iam.serviceAccountTokenCreator ON indexer-runtime@ so it can call
 * iamcredentials signJwt for it:
 *
 *   gcloud iam service-accounts add-iam-policy-binding \
 *     indexer-runtime@mmr-data-pipeline.iam.gserviceaccount.com \
 *     --member="serviceAccount:api-runtime@mmr-data-pipeline.iam.gserviceaccount.com" \
 *     --role="roles/iam.serviceAccountTokenCreator"
 */

import { GoogleAuth } from 'google-auth-library';
import { env } from '../lib/config.js';

const DRIVE = 'https://www.googleapis.com/drive/v3/files';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const SCOPE = 'https://www.googleapis.com/auth/drive.readonly';

const auth = new GoogleAuth({ scopes: ['https://www.googleapis.com/auth/cloud-platform'] });

export interface DriveImage {
  id: string;
  name: string;
  relPath: string;
  mimeType: string;
  md5Checksum?: string;
  modifiedTime?: string;
  size?: string;
}

let cached: { token: string; expiresAt: number } | null = null;

/** Mint (and cache) a Drive access token via keyless DWD. */
export async function getDriveToken(): Promise<string> {
  if (cached && Date.now() < cached.expiresAt - 60_000) return cached.token;

  const sa = env.DWD_SA;
  const now = Math.floor(Date.now() / 1000);
  const claims = JSON.stringify({
    iss: sa,
    sub: env.DWD_SUBJECT,
    scope: SCOPE,
    aud: TOKEN_URL,
    iat: now,
    exp: now + 3600,
  });

  // Sign the JWT via Node's native fetch, NOT client.request (gaxios → node-fetch@2),
  // which throws a spurious "Premature close" on Node 18+ when iamcredentials closes
  // the connection. The token exchange below already uses native fetch, so this
  // keeps the whole mint path on one HTTP client.
  const client = await auth.getClient();
  const accessToken = (await client.getAccessToken()).token;
  const signResp = await fetch(
    `https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/${sa}:signJwt`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ payload: claims }),
    },
  );
  if (!signResp.ok) {
    throw new Error(`signJwt failed: ${signResp.status} ${await signResp.text()}`);
  }
  const { signedJwt } = (await signResp.json()) as { signedJwt: string };

  const body = new URLSearchParams({
    grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
    assertion: signedJwt,
  });
  const tokenRes = await fetch(TOKEN_URL, { method: 'POST', body });
  if (!tokenRes.ok) {
    throw new Error(`DWD token exchange failed: ${tokenRes.status} ${await tokenRes.text()}`);
  }
  const json = (await tokenRes.json()) as { access_token: string; expires_in: number };
  cached = { token: json.access_token, expiresAt: Date.now() + json.expires_in * 1000 };
  return cached.token;
}

async function driveGet(url: string, token: string): Promise<Record<string, unknown>> {
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`Drive API ${res.status}: ${await res.text()}`);
  return (await res.json()) as Record<string, unknown>;
}

/**
 * Recursively list image files in a Drive folder.
 * Mirrors indexer/drive.py `list_images` — same fields, same shortcut policy
 * (shortcuts not followed). Pass `token` explicitly in tests.
 */
export async function listEventImages(folderId: string, opts?: { token?: string; rel?: string }): Promise<DriveImage[]> {
  const token = opts?.token ?? (await getDriveToken());
  const rel = opts?.rel ?? '';
  const items: DriveImage[] = [];
  let pageToken: string | undefined;

  do {
    const params = new URLSearchParams({
      q: `'${folderId}' in parents and trashed=false`,
      fields: 'nextPageToken,files(id,name,mimeType,md5Checksum,modifiedTime,size)',
      pageSize: '1000',
      supportsAllDrives: 'true',
      includeItemsFromAllDrives: 'true',
    });
    if (pageToken) params.set('pageToken', pageToken);

    const page = (await driveGet(`${DRIVE}?${params}`, token)) as {
      nextPageToken?: string;
      files?: Array<Omit<DriveImage, 'relPath'>>;
    };
    for (const f of page.files ?? []) {
      const relPath = `${rel}${f.name}`;
      if (f.mimeType === 'application/vnd.google-apps.folder') {
        items.push(...(await listEventImages(f.id, { token, rel: `${relPath}/` })));
      } else if (f.mimeType.startsWith('image/')) {
        items.push({ ...f, relPath });
      }
    }
    pageToken = page.nextPageToken;
  } while (pageToken);

  return items;
}

/** Fetch metadata for a single Drive file. */
export async function getFileMetadata(fileId: string, opts?: { token?: string }): Promise<DriveImage> {
  const token = opts?.token ?? (await getDriveToken());
  const params = new URLSearchParams({
    fields: 'id,name,mimeType,md5Checksum,modifiedTime,size',
    supportsAllDrives: 'true',
  });
  const f = (await driveGet(`${DRIVE}/${fileId}?${params}`, token)) as Omit<DriveImage, 'relPath'>;
  return { ...f, relPath: f.name };
}
