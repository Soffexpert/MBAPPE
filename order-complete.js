import Stripe from 'stripe';
import { createShopifyOrderFromSession } from './shopify-order.js';
import { closeAbandonedCheckout } from './shopify-abandoned-checkout.js';

function getStripe() {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) throw new Error('STRIPE_SECRET_KEY saknas.');
  return new Stripe(key);
}

export async function completeOrderFromStripeSession(sessionId) {
  if (!sessionId) {
    throw new Error('Saknar session_id.');
  }

  const stripe = getStripe();
  const session = await stripe.checkout.sessions.retrieve(sessionId);

  if (session.payment_status !== 'paid') {
    throw new Error('Betalningen är inte slutförd ännu.');
  }

  if (session.metadata?.shopify_order_id) {
    return {
      orderId: session.metadata.shopify_order_id,
      orderName: session.metadata.shopify_order_name || '',
      email: session.customer_details?.email || '',
      alreadyExisted: true,
    };
  }

  const order = await createShopifyOrderFromSession(stripe, session);

  await stripe.checkout.sessions.update(sessionId, {
    metadata: {
      ...session.metadata,
      shopify_order_id: String(order.id),
      shopify_order_name: order.name || '',
    },
  });

  await closeAbandonedCheckout(session.metadata?.shopify_checkout_token);

  return {
    orderId: order.id,
    orderName: order.name || '',
    email: session.customer_details?.email || order.email || '',
    alreadyExisted: false,
  };
}
