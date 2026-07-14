import Stripe from 'stripe';
import { buildStripeShippingOptions } from './pricing.js';

function getStripe() {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) {
    throw new Error('STRIPE_SECRET_KEY saknas.');
  }
  return new Stripe(key);
}

function normalizeImageUrl(image) {
  if (!image) return null;
  if (image.startsWith('//')) return `https:${image}`;
  return image;
}

export function buildProductLineItems(cartItems) {
  if (!Array.isArray(cartItems) || cartItems.length === 0) {
    throw new Error('Varukorgen är tom.');
  }

  return cartItems.map((item) => {
    const unitAmount = Math.round(Number(item.price) * 100);
    if (!item.title || !unitAmount || unitAmount < 0) {
      throw new Error('Ogiltig produktrad i varukorgen.');
    }

    const productData = {
      name: item.title,
      metadata: {
        type: 'product',
        variant_id: String(item.variant_id || ''),
        product_id: String(item.product_id || ''),
      },
    };

    const imageUrl = normalizeImageUrl(item.image);
    if (imageUrl) {
      productData.images = [imageUrl];
    }

    return {
      price_data: {
        currency: 'sek',
        product_data: productData,
        unit_amount: unitAmount,
      },
      quantity: Number(item.quantity) || 1,
    };
  });
}

const THANK_YOU_RETURN_URL =
  'https://www.soffexpert.se/pages/tack-for-din-bestallning?session_id={CHECKOUT_SESSION_ID}';

function resolveReturnUrl(requestReturnUrl) {
  if (requestReturnUrl) return requestReturnUrl;

  const envUrl = process.env.SUCCESS_URL || '';
  if (envUrl.includes('tack-for-din-bestallning')) {
    return envUrl;
  }

  return THANK_YOU_RETURN_URL;
}

export async function createEmbeddedCheckoutSession({ cartItems, returnUrl }) {
  const stripe = getStripe();
  const lineItems = buildProductLineItems(cartItems);

  const resolvedReturnUrl = resolveReturnUrl(returnUrl);

  const session = await stripe.checkout.sessions.create({
    ui_mode: 'embedded',
    mode: 'payment',
    payment_method_types: ['card', 'klarna'],
    allow_promotion_codes: true,
    line_items: lineItems,
    locale: 'sv',
    return_url: resolvedReturnUrl.includes('{CHECKOUT_SESSION_ID}')
      ? resolvedReturnUrl
      : `${resolvedReturnUrl}${resolvedReturnUrl.includes('?') ? '&' : '?'}session_id={CHECKOUT_SESSION_ID}`,
    shipping_address_collection: { allowed_countries: ['SE'] },
    phone_number_collection: { enabled: true },
    permissions: {
      update_shipping_details: 'server_only',
    },
    shipping_options: [
      {
        shipping_rate_data: {
          type: 'fixed_amount',
          fixed_amount: { amount: 0, currency: 'sek' },
          display_name: 'Ange adress för fraktpris',
        },
      },
    ],
    custom_fields: [
      {
        key: 'order_note',
        label: { type: 'custom', custom: 'Anteckning (t.ex. portkod)' },
        type: 'text',
        optional: true,
      },
    ],
    metadata: {
      source: 'soffexpert_embedded',
      variant_ids: cartItems.map((item) => item.variant_id).join(','),
    },
  });

  return session;
}

export async function updateCheckoutShipping({ checkoutSessionId, shippingDetails }) {
  const stripe = getStripe();
  const postalCode = shippingDetails?.address?.postal_code;

  const shippingOptions = buildStripeShippingOptions(postalCode);
  if (!shippingOptions) {
    return {
      type: 'error',
      message: 'Ogiltigt postnummer. Ange ett svenskt postnummer (5 siffror).',
    };
  }

  await stripe.checkout.sessions.update(checkoutSessionId, {
    collected_information: {
      shipping_details: shippingDetails,
    },
    shipping_options: shippingOptions,
  });

  return { type: 'object', value: { succeeded: true } };
}
