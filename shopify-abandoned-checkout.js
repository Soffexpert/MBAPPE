import Stripe from 'stripe';
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
    const message = data.errors
      ? JSON.stringify(data.errors)
      : data.error || response.statusText;
    const err = new Error(
      `Shopify ${method} ${path} → ${response.status}: ${message || 'Admin API failed.'}`
    );
    err.status = response.status;
    err.shopify = data;
    throw err;
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

function cartItemsFromStripeSession(session) {
  const rows = session.line_items?.data || [];
  const items = [];

  for (const li of rows) {
    const product = typeof li.price?.product === 'object' ? li.price.product : null;
    if (product?.metadata?.type === 'shipping') continue;

    const variantId = Number(
      product?.metadata?.variant_id ||
        li.price?.metadata?.variant_id ||
        0
    );
    if (!variantId) continue;

    items.push({
      variant_id: variantId,
      quantity: Number(li.quantity) || 1,
    });
  }

  // Fallback: metadata.variant_ids (comma-separated), qty 1 each
  if (!items.length) {
    const ids = String(session.metadata?.variant_ids || '')
      .split(',')
      .map((id) => Number(id.trim()))
      .filter(Boolean);
    ids.forEach((variant_id) => items.push({ variant_id, quantity: 1 }));
  }

  return items;
}

/**
 * Shopify Checkout Admin API was shut down Apr 2025.
 * We create Draft Orders tagged stripe-abandoned (Orders → Drafts).
 * Metadata key shopify_checkout_token = draft order id.
 */
export async function createAbandonedCheckoutFromCart({
  cartItems,
  cartToken,
  market,
  stripeSessionId,
  email,
  shippingAddress,
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
      email ? `Email: ${email}` : '',
    ]
      .filter(Boolean)
      .join('\n'),
    tags: 'stripe-abandoned,soffexpert',
  };

  if (email) draft_order.email = email;

  // Only attach address when we have a real street — country-only payloads
  // are rejected by Shopify and silently kill abandoned draft creation.
  if (shippingAddress?.address1) {
    draft_order.shipping_address = shippingAddress;
    draft_order.billing_address = shippingAddress;
  }

  const result = await adminFetch('/draft_orders.json', {
    method: 'POST',
    body: { draft_order },
  });

  const draft = result.draft_order || null;
  if (!draft?.id) {
    console.error('abandoned draft: create returned no id', JSON.stringify(result));
    return null;
  }

  console.log('abandoned draft created', draft.id, email || '(no email yet)');
  return {
    ...draft,
    token: String(draft.id),
    id: draft.id,
  };
}

async function attachDraftTokenToSession(stripe, session, draftToken) {
  await stripe.checkout.sessions.update(session.id, {
    metadata: {
      ...session.metadata,
      shopify_checkout_token: String(draftToken),
    },
  });
  session.metadata = {
    ...(session.metadata || {}),
    shopify_checkout_token: String(draftToken),
  };
}

/**
 * Ensure a draft exists for this Stripe session, then sync email/address.
 * Creates the draft on first sync if create-at-session-start failed / wasn't deployed.
 */
export async function syncAbandonedCheckoutFromStripeSession(session, shippingDetails, stripeClient) {
  const stripe =
    stripeClient ||
    (process.env.STRIPE_SECRET_KEY ? new Stripe(process.env.STRIPE_SECRET_KEY) : null);

  let draftId = session.metadata?.shopify_checkout_token;
  const email = session.customer_details?.email || null;
  const shippingAddress = shippingFromStripe(session, shippingDetails);
  const market = session.metadata?.market || 'sv';

  if (!draftId) {
    if (!stripe) {
      console.warn('abandoned draft sync: no token and no Stripe client to create draft');
      return null;
    }

    const expanded = await stripe.checkout.sessions.retrieve(session.id, {
      expand: ['line_items.data.price.product'],
    });
    const cartItems = cartItemsFromStripeSession(expanded);
    if (!cartItems.length) {
      console.error('abandoned draft sync: cannot create — no variant line items', session.id);
      return null;
    }

    const created = await createAbandonedCheckoutFromCart({
      cartItems,
      cartToken: session.metadata?.cart_token || '',
      market,
      stripeSessionId: session.id,
      email,
      shippingAddress,
    });

    if (!created?.token) return null;
    draftId = created.token;
    await attachDraftTokenToSession(stripe, session, draftId);
    return created;
  }

  const draft_order = {};
  if (email) draft_order.email = email;
  if (shippingAddress?.address1) {
    draft_order.shipping_address = shippingAddress;
    draft_order.billing_address = shippingAddress;
  }

  draft_order.note = [
    'Övergiven Stripe-kassa (ej Shopify Checkout)',
    `Stripe session: ${session.id}`,
    email ? `Email: ${email}` : '',
    session.status ? `Stripe status: ${session.status}` : '',
    `Market: ${market}`,
  ]
    .filter(Boolean)
    .join('\n');

  if (!email && !shippingAddress) {
    // Still update note so draft stays visible / fresh
  }

  const result = await adminFetch(`/draft_orders/${draftId}.json`, {
    method: 'PUT',
    body: { draft_order },
  });

  console.log('abandoned draft synced', draftId, email || '(no email)');
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
