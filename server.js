import http from 'node:http';
import Stripe from 'stripe';
import {
  createEmbeddedCheckoutSession,
  updateCheckoutShipping,
} from './stripe-checkout.js';
import * as orderComplete from './order-complete.js';
import { createShopifyOrderFromSession } from './shopify-order.js';
import { handleSellSofa, getSellSofaMailStatus } from './sell-sofa.js';
import {
  syncAbandonedCheckoutFromStripeSession,
  createAbandonedCheckoutFromCart,
  closeAbandonedCheckout,
} from './shopify-abandoned-checkout.js';
import { getShopifyAccessToken } from './shopify-auth.js';
import { getAdminStoreHost } from './shopify-store.js';

const PORT = process.env.PORT || 3000;

/**
 * Prefer order-complete.fulfillPaidCheckoutSession when present.
 * Fallback keeps the server booting if an older order-complete.js was deployed.
 */
async function fulfillPaidCheckoutSession(sessionId, { allowUnpaid = false } = {}) {
  if (typeof orderComplete.fulfillPaidCheckoutSession === 'function') {
    return orderComplete.fulfillPaidCheckoutSession(sessionId, { allowUnpaid });
  }

  if (!sessionId) throw new Error('Saknar session_id.');

  const stripeKey = process.env.STRIPE_SECRET_KEY;
  if (!stripeKey) throw new Error('STRIPE_SECRET_KEY saknas.');
  const stripe = new Stripe(stripeKey);
  const session = await stripe.checkout.sessions.retrieve(sessionId);

  if (session.metadata?.shopify_order_id) {
    return {
      orderId: session.metadata.shopify_order_id,
      orderName: session.metadata.shopify_order_name || '',
      email: session.customer_details?.email || '',
      alreadyExisted: true,
      paymentStatus: session.payment_status,
      value:
        typeof session.amount_total === 'number' ? session.amount_total / 100 : null,
      currency: String(session.currency || '').toUpperCase() || null,
      contentIds: String(session.metadata?.variant_ids || '')
        .split(',')
        .map((id) => id.trim())
        .filter(Boolean),
    };
  }

  const paid =
    session.payment_status === 'paid' ||
    session.payment_status === 'no_payment_required';

  if (!paid) {
    if (allowUnpaid) {
      return {
        pending: true,
        paymentStatus: session.payment_status,
        orderId: null,
        orderName: '',
        email: session.customer_details?.email || '',
        alreadyExisted: false,
        value: null,
        currency: null,
        contentIds: [],
      };
    }
    const err = new Error('Betalningen är inte slutförd ännu.');
    err.code = 'PAYMENT_PENDING';
    err.paymentStatus = session.payment_status;
    throw err;
  }

  if (typeof orderComplete.completeOrderFromStripeSession === 'function') {
    return orderComplete.completeOrderFromStripeSession(sessionId);
  }

  const order = await createShopifyOrderFromSession(stripe, session);
  await stripe.checkout.sessions.update(sessionId, {
    metadata: {
      ...(session.metadata || {}),
      shopify_order_id: String(order.id),
      shopify_order_name: order.name || '',
    },
  });
  try {
    await closeAbandonedCheckout(session.metadata?.shopify_checkout_token);
  } catch (error) {
    console.error('closeAbandonedCheckout:', error.message || error);
  }

  return {
    orderId: order.id,
    orderName: order.name || '',
    email: session.customer_details?.email || order.email || '',
    alreadyExisted: false,
    paymentStatus: session.payment_status,
    value:
      typeof session.amount_total === 'number' ? session.amount_total / 100 : null,
    currency: String(session.currency || '').toUpperCase() || null,
    contentIds: String(session.metadata?.variant_ids || '')
      .split(',')
      .map((id) => id.trim())
      .filter(Boolean),
  };
}

async function completeOrderFromStripeSession(sessionId) {
  if (typeof orderComplete.completeOrderFromStripeSession === 'function') {
    // New module delegates to fulfillPaidCheckoutSession internally
    if (typeof orderComplete.fulfillPaidCheckoutSession === 'function') {
      return orderComplete.fulfillPaidCheckoutSession(sessionId, { allowUnpaid: false });
    }
    return orderComplete.completeOrderFromStripeSession(sessionId);
  }
  return fulfillPaidCheckoutSession(sessionId, { allowUnpaid: false });
}

function sendJson(res, status, payload) {
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Accept',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  });
  res.end(JSON.stringify(payload));
}

async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function mapCartItems(body) {
  return (body.items || []).map((item) => ({
    variant_id: item.variant_id,
    product_id: item.product_id,
    title: item.title,
    price: item.price,
    quantity: item.quantity,
    image: item.image,
  }));
}

async function handleCreateSession(req, res) {
  try {
    const body = await readJson(req);
    const session = await createEmbeddedCheckoutSession({
      cartItems: mapCartItems(body),
      returnUrl: body.return_url || body.returnUrl,
      market: body.market || body.locale || 'sv',
      cartToken: body.cart_token || body.cartToken || '',
    });

    sendJson(res, 200, {
      clientSecret: session.client_secret,
      sessionId: session.id,
      paymentMethodTypes: session.payment_method_types || [],
    });
  } catch (error) {
    console.error('create-checkout-session:', error);
    sendJson(res, 400, { error: error.message || 'Kunde inte skapa checkout.' });
  }
}

async function handleCalculateShipping(req, res) {
  try {
    const body = await readJson(req);
    const sessionId = body.checkout_session_id || body.checkoutSessionId;
    const shippingDetails = body.shipping_details || body.shippingDetails;

    if (!sessionId || !shippingDetails) {
      sendJson(res, 400, {
        type: 'error',
        message: 'Saknar session eller adress.',
      });
      return;
    }

    const result = await updateCheckoutShipping({
      checkoutSessionId: sessionId,
      shippingDetails,
      market: body.market || body.locale || 'sv',
    });

    sendJson(res, 200, result);
  } catch (error) {
    console.error('calculate-shipping:', error);
    sendJson(res, 400, {
      type: 'error',
      message: error.message || 'Kunde inte beräkna frakt.',
    });
  }
}

async function handleWebhook(req, res) {
  const stripeKey = process.env.STRIPE_SECRET_KEY;
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

  if (!stripeKey || !webhookSecret) {
    res.writeHead(500);
    res.end('Webhook secrets saknas.');
    return;
  }

  const stripe = new Stripe(stripeKey);
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(chunk);
  }
  const rawBody = Buffer.concat(chunks);

  let event;
  try {
    event = stripe.webhooks.constructEvent(
      rawBody,
      req.headers['stripe-signature'],
      webhookSecret
    );
  } catch (error) {
    console.error('Webhook signature failed:', error.message);
    res.writeHead(400);
    res.end('Felaktig signatur');
    return;
  }

  if (event.type === 'checkout.session.expired') {
    try {
      await syncAbandonedCheckoutFromStripeSession(event.data.object);
    } catch (error) {
      console.error('abandoned checkout sync (expired):', error.message);
    }
  }

  // Klarna/async: completed may be unpaid — also listen for async_payment_succeeded
  if (
    event.type === 'checkout.session.completed' ||
    event.type === 'checkout.session.async_payment_succeeded'
  ) {
    try {
      const session = event.data.object;
      const result = await fulfillPaidCheckoutSession(session.id, { allowUnpaid: true });
      if (result.pending) {
        console.log(
          'Checkout completed but payment still pending:',
          session.id,
          result.paymentStatus
        );
      } else {
        console.log(
          'Fulfillment ok:',
          result.orderName || result.orderId,
          'already=',
          result.alreadyExisted,
          'event=',
          event.type
        );
      }
    } catch (error) {
      console.error('Shopify order failed:', error);
      // 500 so Stripe retries — critical for Klarna delayed capture
      res.writeHead(500);
      res.end(`Shopify order error: ${error.message}`);
      return;
    }
  }

  if (event.type === 'checkout.session.async_payment_failed') {
    console.error('Async payment failed for session', event.data.object?.id);
  }

  res.writeHead(200);
  res.end('ok');
}

async function handleSyncAbandonedCheckout(req, res) {
  try {
    const body = await readJson(req);
    const sessionId = body.checkout_session_id || body.checkoutSessionId || body.session_id;
    if (!sessionId) {
      sendJson(res, 400, { error: 'Saknar checkout_session_id.' });
      return;
    }

    const stripeKey = process.env.STRIPE_SECRET_KEY;
    if (!stripeKey) {
      sendJson(res, 500, { error: 'STRIPE_SECRET_KEY saknas.' });
      return;
    }

    const stripe = new Stripe(stripeKey);
    const session = await stripe.checkout.sessions.retrieve(sessionId);
    const checkout = await syncAbandonedCheckoutFromStripeSession(session, null, stripe);

    sendJson(res, 200, {
      synced: Boolean(checkout),
      draftId: checkout?.id || session.metadata?.shopify_checkout_token || null,
      email: session.customer_details?.email || null,
    });
  } catch (error) {
    console.error('sync-abandoned-checkout:', error);
    sendJson(res, 400, { error: error.message || 'Kunde inte synka övergiven checkout.' });
  }
}

async function handleDebugDraftOrder(req, res) {
  try {
    const { store, token } = await getShopifyAccessToken();
    const adminStore = getAdminStoreHost(store);
    const scopesRes = await fetch(
      `https://${adminStore}/admin/oauth/access_scopes.json`,
      { headers: { 'X-Shopify-Access-Token': token } }
    );
    const scopesData = await scopesRes.json().catch(() => ({}));

    const body = await readJson(req).catch(() => ({}));
    const variantId = Number(body.variant_id || 0);

    let createResult = null;
    let createError = null;
    if (variantId) {
      try {
        createResult = await createAbandonedCheckoutFromCart({
          cartItems: [{ variant_id: variantId, quantity: 1 }],
          cartToken: 'debug',
          market: body.market || 'sv',
          stripeSessionId: 'debug_' + Date.now(),
          email: body.email || undefined,
        });
      } catch (error) {
        createError = error.message || String(error);
      }
    }

    sendJson(res, 200, {
      store: adminStore,
      scopes: scopesData,
      hasWriteDraftOrders: JSON.stringify(scopesData).includes('write_draft_orders'),
      createResult: createResult
        ? { id: createResult.id, token: createResult.token }
        : null,
      createError,
      hint: variantId
        ? null
        : 'POST {"variant_id":123456789} to also test draft create',
    });
  } catch (error) {
    console.error('debug-draft-order:', error);
    sendJson(res, 500, { error: error.message || 'Debug failed.' });
  }
}

async function handleSellSofaRequest(req, res) {
  try {
    const result = await handleSellSofa(req);
    if (result.error) {
      sendJson(res, 400, { error: result.error });
      return;
    }
    sendJson(res, 200, { success: true });
  } catch (error) {
    console.error('sell-sofa:', error);
    sendJson(res, 500, { error: error.message || 'Kunde inte skicka förfrågan.' });
  }
}

async function handleCompleteOrder(req, res) {
  try {
    const body = await readJson(req);
    const sessionId =
      body.session_id || body.sessionId || new URL(req.url, 'http://x').searchParams.get('session_id');

    const result = await completeOrderFromStripeSession(sessionId);
    sendJson(res, 200, result);
  } catch (error) {
    console.error('complete-order:', error);
    sendJson(res, 400, {
      error: error.message || 'Kunde inte slutföra ordern.',
      code: error.code || null,
      paymentStatus: error.paymentStatus || null,
    });
  }
}

/** Manual recovery: create Shopify order from a paid Stripe session_id */
async function handleRecoverOrder(req, res) {
  try {
    const body = await readJson(req).catch(() => ({}));
    const sessionId =
      body.session_id || body.sessionId || new URL(req.url, 'http://x').searchParams.get('session_id');
    if (!sessionId) {
      sendJson(res, 400, { error: 'Skicka { "session_id": "cs_..." }' });
      return;
    }
    const result = await fulfillPaidCheckoutSession(sessionId);
    sendJson(res, 200, result);
  } catch (error) {
    console.error('recover-order:', error);
    sendJson(res, 400, { error: error.message || 'Kunde inte återskapa order.' });
  }
}

async function handleDebugOrder(req, res) {
  try {
    const body = await readJson(req).catch(() => ({}));
    const { store, token } = await getShopifyAccessToken();
    const adminStore = getAdminStoreHost(store);
    const scopesRes = await fetch(
      `https://${adminStore}/admin/oauth/access_scopes.json`,
      { headers: { 'X-Shopify-Access-Token': token } }
    );
    const scopesData = await scopesRes.json().catch(() => ({}));
    const scopeStr = JSON.stringify(scopesData);

    let fulfill = null;
    let fulfillError = null;
    if (body.session_id) {
      try {
        fulfill = await fulfillPaidCheckoutSession(body.session_id);
      } catch (error) {
        fulfillError = error.message || String(error);
      }
    }

    sendJson(res, 200, {
      store: adminStore,
      hasWriteOrders: scopeStr.includes('write_orders'),
      hasWriteProducts: scopeStr.includes('write_products'),
      hasWriteDraftOrders: scopeStr.includes('write_draft_orders'),
      scopes: scopesData,
      fulfill,
      fulfillError,
      hint: body.session_id
        ? null
        : 'POST {"session_id":"cs_..."} to fulfill a paid Stripe session now',
    });
  } catch (error) {
    console.error('debug-order:', error);
    sendJson(res, 500, { error: error.message || 'Debug failed.' });
  }
}

function handleConfig(res) {
  const publishableKey = process.env.STRIPE_PUBLISHABLE_KEY || '';
  sendJson(res, 200, { publishableKey });
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') {
    sendJson(res, 204, {});
    return;
  }

  const url = new URL(req.url, `http://${req.headers.host}`);
  let path = url.pathname.replace(/\/$/, '') || '/';
  if (path.startsWith('/proxy/')) {
    path = path.slice('/proxy'.length) || '/';
  }

  if (req.method === 'POST' && path === '/create-checkout-session') {
    await handleCreateSession(req, res);
    return;
  }

  if (req.method === 'POST' && path === '/calculate-shipping') {
    await handleCalculateShipping(req, res);
    return;
  }

  if (req.method === 'POST' && path === '/webhook') {
    await handleWebhook(req, res);
    return;
  }

  if (req.method === 'POST' && path === '/complete-order') {
    await handleCompleteOrder(req, res);
    return;
  }

  if (req.method === 'POST' && path === '/recover-order') {
    await handleRecoverOrder(req, res);
    return;
  }

  if (
    (req.method === 'GET' || req.method === 'POST') &&
    path === '/debug-order'
  ) {
    await handleDebugOrder(req, res);
    return;
  }

  if (req.method === 'POST' && path === '/sync-abandoned-checkout') {
    await handleSyncAbandonedCheckout(req, res);
    return;
  }

  if (req.method === 'POST' && path === '/sell-sofa') {
    await handleSellSofaRequest(req, res);
    return;
  }

  if (req.method === 'GET' && path === '/config') {
    handleConfig(res);
    return;
  }

  if (req.method === 'GET' && path === '/health') {
    sendJson(res, 200, {
      ok: true,
      sellSofaMail: getSellSofaMailStatus(),
    });
    return;
  }

  if (
    (req.method === 'GET' || req.method === 'POST') &&
    path === '/debug-draft-order'
  ) {
    await handleDebugDraftOrder(req, res);
    return;
  }

  sendJson(res, 404, { error: 'Not found' });
});

server.listen(PORT, () => {
  console.log(`Soffexpert Stripe API listening on port ${PORT}`);
});
