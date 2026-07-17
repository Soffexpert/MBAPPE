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
  const parts = String(name || '')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
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
    phone: session.customer_details?.phone || shipping?.phone || '',
  };
}

/**
 * Shopify Checkout Admin API was shut down Apr 2025, so we create Draft Orders
 * tagged as abandoned Stripe checkouts. They show under Orders → Drafts.
 * Metadata key remains shopify_checkout_token (= draft order id) for compatibility.
 */
export async function createAbandonedCheckoutFromCart({
  cartItems,
  cartToken,
  market,
  stripeSessionId,
}) {
  const line_items = buildLineItems(cartItems);
  if (!line_items.length) {
    console.warn('abandoned draft: no valid line_items');
    return null;
  }

  const draft_order = {
    line_items,
    note: [
      'Övergiven Stripe-kassa (ej Shopify Checkout)',
      stripeSessionId ? `Stripe session: ${stripeSessionId}` : '',
      cartToken ? `Cart token: ${cartToken}` : '',
      `Market: ${market || 'sv'}`,
    ]
      .filter(Boolean)
      .join('\n'),
    tags: 'stripe-abandoned,soffexpert',
    shipping_address: {
      country_code: getCountryCode(market),
    },
  };

  const result = await adminFetch('/draft_orders.json', {
    method: 'POST',
    body: { draft_order },
  });

  const draft = result.draft_order || null;
  if (!draft?.id) {
    console.error('abandoned draft: create returned no id', result);
    return null;
  }

  return {
    ...draft,
    token: String(draft.id),
    id: draft.id,
  };
}

export async function syncAbandonedCheckoutFromStripeSession(session, shippingDetails) {
  const draftId = session.metadata?.shopify_checkout_token;
  if (!draftId) {
    console.warn('abandoned draft sync: missing shopify_checkout_token on session', session.id);
    return null;
  }

  const email = session.customer_details?.email;
  const shippingAddress = shippingFromStripe(session, shippingDetails);

  const draft_order = {};
  if (email) draft_order.email = email;
  if (shippingAddress) {
    draft_order.shipping_address = shippingAddress;
    draft_order.billing_address = shippingAddress;
  }

  const noteExtra = [
    session.id ? `Stripe session: ${session.id}` : '',
    email ? `Email: ${email}` : '',
    session.status ? `Stripe status: ${session.status}` : '',
  ]
    .filter(Boolean)
    .join('\n');

  if (noteExtra) {
    draft_order.note = [
      'Övergiven Stripe-kassa (ej Shopify Checkout)',
      noteExtra,
      `Market: ${session.metadata?.market || 'sv'}`,
    ].join('\n');
  }

  if (!Object.keys(draft_order).length) return null;

  const result = await adminFetch(`/draft_orders/${draftId}.json`, {
    method: 'PUT',
    body: { draft_order },
  });

  return result.draft_order || null;
}

export async function closeAbandonedCheckout(checkoutToken) {
  if (!checkoutToken) return;
  try {
    await adminFetch(`/draft_orders/${checkoutToken}.json`, { method: 'DELETE' });
  } catch (error) {
    console.error('Could not close abandoned draft order:', error.message);
  }
}
