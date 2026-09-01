/**
 * IGDB API Authentication Module
 * Handles OAuth 2.0 Client Credentials flow for IGDB API access via Twitch
 */

interface TokenResponse {
  access_token: string;
  expires_in: number;
  token_type: string;
}

interface CachedToken {
  token: string;
  expiresAt: number;
}

let cachedToken: CachedToken | null = null;

/**
 * Get a valid access token for IGDB API
 * Fetches a new token or returns cached token if still valid
 */
export async function getAccessToken(): Promise<string> {
  const clientId = process.env['IGDB_CLIENT_ID'];
  const clientSecret = process.env['IGDB_CLIENT_SECRET'];

  if (!clientId || !clientSecret) {
    throw new Error(
      'IGDB_CLIENT_ID and IGDB_CLIENT_SECRET environment variables must be configured'
    );
  }

  // Return cached token if still valid (with 5 minute buffer)
  if (cachedToken && cachedToken.expiresAt > Date.now() + 5 * 60 * 1000) {
    return cachedToken.token;
  }

  // Fetch new token from Twitch OAuth endpoint
  try {
    const response = await fetch('https://id.twitch.tv/oauth2/token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        grant_type: 'client_credentials',
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Failed to obtain IGDB access token: ${response.status} ${errorText}`);
    }

    const data = (await response.json()) as TokenResponse;

    // Cache token with expiry time
    cachedToken = {
      token: data.access_token,
      expiresAt: Date.now() + data.expires_in * 1000,
    };

    return cachedToken.token;
  } catch (error) {
    if (error instanceof Error) {
      throw new Error(`IGDB authentication failed: ${error.message}`, { cause: error });
    }
    throw new Error('IGDB authentication failed with unknown error', { cause: error });
  }
}

/**
 * Clear cached token (useful for testing or forcing refresh)
 */
export function clearTokenCache(): void {
  cachedToken = null;
}
