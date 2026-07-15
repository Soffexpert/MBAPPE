import http from 'node:http';
import Stripe from 'stripe';
import {
  createEmbeddedCheckoutSession,
  updateCheckoutShipping,
} from './stripe-checkout.js';
import { createShopifyOrderFromSession } from './shopify-order.js';
import { completeOrderFromStripeSession } from './order-complete.js';
import { handleSellSofa, getSellSofaMailStatus } from './sell-sofa.js';
import {
  syncAbandonedCheckoutFromStripeSession,
  closeAbandonedCheckout,
} from './shopify-abandoned-checkout.js';

const PORT = process.env.PORT || 3000;

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

  if (event.type === 'checkout.session.completed') {
    try {
      const session = event.data.object;
      if (!session.metadata?.shopify_order_id) {
        const order = await createShopifyOrderFromSession(stripe, session);
        await stripe.checkout.sessions.update(session.id, {
          metadata: {
            ...session.metadata,
            shopify_order_id: String(order.id),
            shopify_order_name: order.name || '',
          },
        });
        await closeAbandonedCheckout(session.metadata?.shopify_checkout_token);
        console.log('Shopify order created:', order.name || order.id);
      } else {
        console.log('Shopify order already exists:', session.metadata.shopify_order_name);
      }
    } catch (error) {
      console.error('Shopify order failed:', error);
      res.writeHead(500);
      res.end(`Shopify order error: ${error.message}`);
      return;
    }
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
    const checkout = await syncAbandonedCheckoutFromStripeSession(session);

    sendJson(res, 200, {
      synced: Boolean(checkout),
      email: session.customer_details?.email || null,
    });
  } catch (error) {
    console.error('sync-abandoned-checkout:', error);
    sendJson(res, 400, { error: error.message || 'Kunde inte synka övergiven checkout.' });
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
    sendJson(res, 400, { error: error.message || 'Kunde inte slutföra ordern.' });
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

  sendJson(res, 404, { error: 'Not found' });
});

server.listen(PORT, () => {
  console.log(`Soffexpert Stripe API listening on port ${PORT}`);
});
