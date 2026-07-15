import { getShopifyAccessToken } from './shopify-auth.js';
import { getAdminStoreHost } from './shopify-store.js';

const API_VERSION = '2025-01';

async function adminFetch(path, { method = 'GET', body } = {}) {
  const { store, token } = await getShopifyAccessToken();
  const adminStore = getAdminStoreHost(store);
  const response = await fetch(`https://${adminStore}/admin/api/${API_VERSION}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      'X-Shopify-Access-Token': token,
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = data.errors ? JSON.stringify(data.errors) : response.statusText;
    throw new Error(message || 'Shopify Admin API failed.');
  }
  return data;
}

function getCountryCode(market) {
  return market === 'da' ? 'DK' : 'SE';
}

function buildLineItems(cartItems) {
  return cartItems
    .map((item) => ({
      variant_id: Number(item.variant_id),
      quantity: Number(item.quantity) || 1,
    }))
    .filter((item) => item.variant_id && item.quantity > 0);
}

function splitName(name) {
  const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
  return {
    first_name: parts[0] || '',
    last_name: parts.slice(1).join(' ') || '',
  };
}

function shippingFromStripe(session, shippingDetails) {
  const shipping =
    shippingDetails ||
    session.shipping_details ||
    session.collected_information?.shipping_details;
  const address = shipping?.address;
  if (!address) return null;

  const name = splitName(shipping?.name || session.customer_details?.name || '');

  return {
    first_name: name.first_name,
    last_name: name.last_name,
    address1: address.line1 || '',
    address2: address.line2 || '',
    city: address.city || '',
    zip: address.postal_code || '',
    country_code: address.country || getCountryCode(session.metadata?.market),
    phone: session.customer_details?.phone || '',
  };
}

export async function createAbandonedCheckoutFromCart({ cartItems, cartToken, market, stripeSessionId }) {
  const line_items = buildLineItems(cartItems);
  if (!line_items.length) return null;

  const checkout = {
    line_items,
    note: [
      'Stripe embedded checkout',
      stripeSessionId ? `Stripe session: ${stripeSessionId}` : '',
      cartToken ? `Cart token: ${cartToken}` : '',
    ]
      .filter(Boolean)
      .join('\n'),
    shipping_address: {
      country_code: getCountryCode(market),
    },
  };

  const result = await adminFetch('/checkouts.json', {
    method: 'POST',
    body: { checkout },
  });

  return result.checkout || null;
}

export async function syncAbandonedCheckoutFromStripeSession(session, shippingDetails) {
  const checkoutToken = session.metadata?.shopify_checkout_token;
  if (!checkoutToken) return null;

  const email = session.customer_details?.email;
  const shippingAddress = shippingFromStripe(session, shippingDetails);
  const shippingTotal = (session.total_details?.amount_shipping || 0) / 100;

  const checkout = {};
  if (email) checkout.email = email;
  if (shippingAddress) checkout.shipping_address = shippingAddress;
  if (shippingTotal > 0) {
    checkout.shipping_line = {
      title: 'Frakt (Stripe)',
      price: shippingTotal.toFixed(2),
    };
  }

  if (!Object.keys(checkout).length) return null;

  const result = await adminFetch(`/checkouts/${checkoutToken}.json`, {
    method: 'PUT',
    body: { checkout },
  });

  return result.checkout || null;
}

export async function closeAbandonedCheckout(checkoutToken) {
  if (!checkoutToken) return;
  try {
    await adminFetch(`/checkouts/${checkoutToken}.json`, { method: 'DELETE' });
  } catch (error) {
    console.error('Could not close abandoned checkout:', error.message);
  }
}
