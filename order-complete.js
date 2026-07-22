import Stripe from 'stripe';
import { createShopifyOrderFromSession } from './shopify-order.js';
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

/**
 * Create Shopify order only when Stripe payment is actually paid.
 * Safe to call from webhook (completed / async_payment_succeeded) and thank-you page.
 */
export async function fulfillPaidCheckoutSession(sessionId, { allowUnpaid = false } = {}) {
  if (!sessionId) {
    throw new Error('Saknar session_id.');
  }

  const stripe = getStripe();
  const session = await stripe.checkout.sessions.retrieve(sessionId, {
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

  console.log('Shopify order created:', order.name || order.id, 'session', sessionId);
  return buildResult(session, order, false);
}

export async function completeOrderFromStripeSession(sessionId) {
  return fulfillPaidCheckoutSession(sessionId, { allowUnpaid: false });
}
