import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * googleCredentials covers BOTH credential providers (AZ1 acceptance):
 *   - gcp   → metadata/ADC GoogleAuth, keyless DWD + OIDC ID tokens.
 *   - azure → explicit SA key, DWD unchanged, OIDC skipped (internal ingress).
 * google-auth-library is mocked so no real network / metadata server is hit;
 * the token-exchange fetch is stubbed on the global.
 */

const h = vi.hoisted(() => ({
  request: vi.fn(),
  getAccessToken: vi.fn(),
  getIdTokenClient: vi.fn(),
  getProjectId: vi.fn(),
  lastAuthOpts: undefined as unknown,
}));

vi.mock('google-auth-library', () => {
  class GoogleAuth {
    constructor(opts: unknown) {
      h.lastAuthOpts = opts;
    }
    getClient() {
      return Promise.resolve({ request: h.request, getAccessToken: h.getAccessToken });
    }
    getIdTokenClient(aud: string) {
      return h.getIdTokenClient(aud);
    }
    getProjectId() {
      return h.getProjectId();
    }
  }
  return { GoogleAuth };
});

const FAKE_KEY = { type: 'service_account', client_email: 'indexer-runtime@x.iam.gserviceaccount.com', private_key: 'PK' };

/** (Re)load config + googleCredentials fresh with the given env. */
async function load(overrides: Record<string, string | undefined>) {
  vi.resetModules();
  for (const k of ['CLOUD_PROVIDER', 'GOOGLE_SA_KEY_JSON', 'GCP_PROJECT_ID']) delete process.env[k];
  process.env.NODE_ENV = 'test';
  for (const [k, v] of Object.entries(overrides)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  return import('../src/lib/googleCredentials.js');
}

function stubTokenExchange(accessToken = 'ACCESS_TOKEN', expiresIn = 3600) {
  const fetchMock = vi.fn(async () => ({
    ok: true,
    json: async () => ({ access_token: accessToken, expires_in: expiresIn }),
    text: async () => '',
  }));
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  return fetchMock;
}

beforeEach(() => {
  h.request.mockReset();
  h.getAccessToken.mockReset();
  h.getIdTokenClient.mockReset();
  h.getProjectId.mockReset();
  h.lastAuthOpts = undefined;
});

describe('mintDwdToken (gcp)', () => {
  it('signs a JWT as the DWD SA and exchanges it for a scoped access token', async () => {
    h.request.mockResolvedValue({ data: { signedJwt: 'SIGNED.JWT' } });
    const fetchMock = stubTokenExchange('DWD_AT');
    const { mintDwdToken } = await load({});

    const token = await mintDwdToken({ scope: 'scope-a', subject: 'user@x.org' });
    expect(token).toBe('DWD_AT');

    // signJwt hit iamcredentials for the default DWD SA.
    const signArg = h.request.mock.calls[0][0];
    expect(signArg.url).toContain(
      'indexer-runtime@mmr-data-pipeline.iam.gserviceaccount.com:signJwt',
    );
    const claims = JSON.parse(signArg.data.payload);
    expect(claims).toMatchObject({ sub: 'user@x.org', scope: 'scope-a' });

    // token exchange carried the signed assertion.
    const body = fetchMock.mock.calls[0][1].body as URLSearchParams;
    expect(body.get('assertion')).toBe('SIGNED.JWT');
    expect(body.get('grant_type')).toBe('urn:ietf:params:oauth:grant-type:jwt-bearer');
  });

  it('caches per (subject, scope) and re-mints for a different scope', async () => {
    h.request.mockResolvedValue({ data: { signedJwt: 'S' } });
    const fetchMock = stubTokenExchange();
    const { mintDwdToken } = await load({});

    await mintDwdToken({ scope: 'scope-a', subject: 'u@x.org' });
    await mintDwdToken({ scope: 'scope-a', subject: 'u@x.org' });
    expect(fetchMock).toHaveBeenCalledTimes(1); // second call served from cache

    await mintDwdToken({ scope: 'scope-b', subject: 'u@x.org' });
    expect(fetchMock).toHaveBeenCalledTimes(2); // different scope → new mint
  });

  it('throws with the upstream status on a failed exchange', async () => {
    h.request.mockResolvedValue({ data: { signedJwt: 'S' } });
    globalThis.fetch = vi.fn(async () => ({
      ok: false,
      status: 403,
      text: async () => 'PERMISSION_DENIED',
    })) as unknown as typeof fetch;
    const { mintDwdToken } = await load({});
    await expect(mintDwdToken({ scope: 's', subject: 'u@x.org' })).rejects.toThrow(/403/);
  });
});

describe('getIdTokenHeaders (gcp)', () => {
  it('mints an ID token for an https audience', async () => {
    h.getIdTokenClient.mockResolvedValue({
      getRequestHeaders: async () => ({ Authorization: 'Bearer ID_TOKEN' }),
    });
    const { getIdTokenHeaders } = await load({});
    const headers = await getIdTokenHeaders('https://svc.run.app', 'https://svc.run.app/search');
    expect(headers).toEqual({ Authorization: 'Bearer ID_TOKEN' });
    expect(h.getIdTokenClient).toHaveBeenCalledWith('https://svc.run.app');
  });

  it('skips token minting for a plain-http (local dev) URL', async () => {
    const { getIdTokenHeaders } = await load({});
    const headers = await getIdTokenHeaders('http://localhost:8081', 'http://localhost:8081/search');
    expect(headers).toEqual({});
    expect(h.getIdTokenClient).not.toHaveBeenCalled();
  });
});

describe('getAccessToken (gcp)', () => {
  it('returns the cloud-platform token (object form)', async () => {
    h.getAccessToken.mockResolvedValue({ token: 'CP_TOKEN' });
    const { getAccessToken } = await load({});
    expect(await getAccessToken()).toBe('CP_TOKEN');
  });

  it('throws when no token can be minted', async () => {
    h.getAccessToken.mockResolvedValue({ token: null });
    const { getAccessToken } = await load({});
    await expect(getAccessToken()).rejects.toThrow(/could not mint/);
  });
});

describe('azure provider', () => {
  const azureEnv = {
    CLOUD_PROVIDER: 'azure',
    GCP_PROJECT_ID: 'proj-x',
    GOOGLE_SA_KEY_JSON: JSON.stringify(FAKE_KEY),
  };

  it('builds GoogleAuth from the explicit SA key', async () => {
    h.request.mockResolvedValue({ data: { signedJwt: 'S' } });
    stubTokenExchange();
    const { mintDwdToken, serviceAccountKey } = await load(azureEnv);

    expect(serviceAccountKey()).toEqual(FAKE_KEY);
    await mintDwdToken({ scope: 's', subject: 'u@x.org' }); // triggers baseAuth()
    expect((h.lastAuthOpts as { credentials?: unknown }).credentials).toEqual(FAKE_KEY);
  });

  it('skips OIDC ID tokens (internal ingress, plain HTTP)', async () => {
    const { getIdTokenHeaders } = await load(azureEnv);
    const headers = await getIdTokenHeaders('https://svc', 'https://svc/search');
    expect(headers).toEqual({});
    expect(h.getIdTokenClient).not.toHaveBeenCalled();
  });

  it('returns the explicit project id without a metadata lookup', async () => {
    const { getProjectId } = await load(azureEnv);
    expect(await getProjectId()).toBe('proj-x');
    expect(h.getProjectId).not.toHaveBeenCalled();
  });

  it('config rejects azure without GCP_PROJECT_ID / GOOGLE_SA_KEY_JSON', async () => {
    vi.resetModules();
    process.env.NODE_ENV = 'test';
    process.env.CLOUD_PROVIDER = 'azure';
    delete process.env.GCP_PROJECT_ID;
    delete process.env.GOOGLE_SA_KEY_JSON;
    await expect(import('../src/lib/config.js')).rejects.toThrow(/GCP_PROJECT_ID|GOOGLE_SA_KEY_JSON/);
  });
});

describe('serviceAccountKey (gcp)', () => {
  it('is null when no key is set (keyless ADC)', async () => {
    const { serviceAccountKey } = await load({});
    expect(serviceAccountKey()).toBeNull();
  });
});
