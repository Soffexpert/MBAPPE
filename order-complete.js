import Stripe from 'stripe';
import {
  createShopifyOrderFromSession,
  findOrderByStripeSessionId,
} from './shopify-order.js';
import { closeAbandonedCheckout } from './shopify-abandoned-checkout.js';

function getStripe() {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) throw new Error('STRIPE_SECRET_KEY saknas.');
  return new Stripe(key);
}

function buildResult(session, order, alreadyExisted) {
  return {
    orderId: order?.id || session.metadata?.shopify_order_id || null,
    orderName: order?.name || session.metadata?.shopify_order_name || '',
    email: session.customer_details?.email || order?.email || '',
    alreadyExisted: Boolean(alreadyExisted),
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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Prevent webhook + thank-you from both creating orders (race).
 * Claims a lock in Stripe metadata; losers wait for the winner's shopify_order_id.
 */
async function claimOrWaitForFulfillment(stripe, sessionId) {
  for (let attempt = 0; attempt < 12; attempt++) {
    const session = await stripe.checkout.sessions.retrieve(sessionId);

    if (session.metadata?.shopify_order_id) {
      return { session, alreadyExisted: true };
    }

    const lock = session.metadata?.shopify_fulfillment_lock || '';
    const lockAgeMs = lock ? Date.now() - Number(lock) : Infinity;
    const lockHeldByOther = lock && Number.isFinite(lockAgeMs) && lockAgeMs >= 0 && lockAgeMs < 90_000;

    if (!lockHeldByOther) {
      const lockValue = String(Date.now());
      await stripe.checkout.sessions.update(sessionId, {
        metadata: {
          ...(session.metadata || {}),
          shopify_fulfillment_lock: lockValue,
        },
      });

      // Re-read — if another worker wrote order id or a newer lock, back off
      const claimed = await stripe.checkout.sessions.retrieve(sessionId);
      if (claimed.metadata?.shopify_order_id) {
        return { session: claimed, alreadyExisted: true };
      }
      if (claimed.metadata?.shopify_fulfillment_lock === lockValue) {
        return { session: claimed, alreadyExisted: false };
      }
    }

    await sleep(800 + attempt * 200);
  }

  const session = await stripe.checkout.sessions.retrieve(sessionId);
  if (session.metadata?.shopify_order_id) {
    return { session, alreadyExisted: true };
  }

  // Stale lock — proceed carefully; findExistingOrder will still guard
  return { session, alreadyExisted: false };
}

/**
 * Create Shopify order only when Stripe payment is actually paid.
 * Safe to call from webhook + thank-you concurrently (idempotent).
 */
export async function fulfillPaidCheckoutSession(sessionId, { allowUnpaid = false } = {}) {
  if (!sessionId) {
    throw new Error('Saknar session_id.');
  }

  const stripe = getStripe();
  let session = await stripe.checkout.sessions.retrieve(sessionId, {
    expand: ['total_details', 'customer_details'],
  });

  if (session.metadata?.shopify_order_id) {
    return buildResult(session, null, true);
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

  // Deduplicate concurrent fulfill calls (webhook + thank-you page)
  const claimed = await claimOrWaitForFulfillment(stripe, sessionId);
  session = claimed.session;
  if (claimed.alreadyExisted || session.metadata?.shopify_order_id) {
    return buildResult(session, null, true);
  }

  // Extra guard: order may exist even if metadata write failed earlier
  const existing = await findOrderByStripeSessionId(sessionId);
  if (existing) {
    await stripe.checkout.sessions.update(sessionId, {
      metadata: {
        ...(session.metadata || {}),
        shopify_order_id: String(existing.id),
        shopify_order_name: existing.name || '',
      },
    });
    return buildResult(
      { ...session, metadata: { ...session.metadata, shopify_order_id: String(existing.id), shopify_order_name: existing.name || '' } },
      existing,
      true
    );
  }

  const order = await createShopifyOrderFromSession(stripe, session);

  await stripe.checkout.sessions.update(sessionId, {
    metadata: {
      ...(session.metadata || {}),
      shopify_order_id: String(order.id),
      shopify_order_name: order.name || '',
      shopify_fulfillment_lock: session.metadata?.shopify_fulfillment_lock || String(Date.now()),
    },
  });

  try {
    await closeAbandonedCheckout(session.metadata?.shopify_checkout_token);
  } catch (error) {
    console.error('closeAbandonedCheckout:', error.message || error);
  }

  console.log('Shopify order created:', order.name || order.id, 'session', sessionId);
  return buildResult(session, order, false);
}

export async function completeOrderFromStripeSession(sessionId) {
  return fulfillPaidCheckoutSession(sessionId, { allowUnpaid: false });
}
