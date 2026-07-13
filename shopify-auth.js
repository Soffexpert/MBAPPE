const TOKEN_CACHE = {
  token: null,
  expiresAt: 0,
};

function getShopifyConfig() {
  const store = process.env.SHOPIFY_STORE;
  const clientId = process.env.SHOPIFY_CLIENT_ID;
  const clientSecret = process.env.SHOPIFY_CLIENT_SECRET;
  const staticToken = process.env.SHOPIFY_ADMIN_TOKEN;

  if (!store) {
    throw new Error('SHOPIFY_STORE saknas.');
  }

  if (staticToken) {
    return { store, token: staticToken };
  }

  if (!clientId || !clientSecret) {
    throw new Error(
      'Saknar SHOPIFY_ADMIN_TOKEN eller SHOPIFY_CLIENT_ID + SHOPIFY_CLIENT_SECRET.'
    );
  }

  return { store, clientId, clientSecret };
}

async function fetchAccessToken(store, clientId, clientSecret) {
  const shop = store.replace(/^https?:\/\//, '').replace(/\/$/, '');
  const response = await fetch(`https://${shop}/admin/oauth/access_token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: clientId,
      client_secret: clientSecret,
    }),
  });

  const body = await response.json();
  if (!response.ok) {
    throw new Error(body.error_description || body.error || 'Kunde inte hämta Shopify-token.');
  }

  const expiresIn = Number(body.expires_in || 86399);
  TOKEN_CACHE.token = body.access_token;
  TOKEN_CACHE.expiresAt = Date.now() + expiresIn * 1000 - 60_000;

  return body.access_token;
}

export async function getShopifyAccessToken() {
  const config = getShopifyConfig();

  if (config.token) {
    return { store: config.store, token: config.token };
  }

  if (TOKEN_CACHE.token && Date.now() < TOKEN_CACHE.expiresAt) {
    return { store: config.store, token: TOKEN_CACHE.token };
  }

  const token = await fetchAccessToken(config.store, config.clientId, config.clientSecret);
  return { store: config.store, token };
}
