import Stripe from 'stripe';
import { buildStripeShippingOptions } from './pricing.js';

const SEK_TO_DKK = Number(process.env.SEK_TO_DKK_RATE || 0.63);

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

function getMarketConfig(market) {
  const configs = {
    da: {
      locale: 'da',
      currency: 'dkk',
      countries: ['DK'],
      noteLabel: 'Note (f.eks. dørkode)',
      shippingPlaceholder: 'Angiv adresse for fragtpris',
      invalidZip: 'Ugyldigt postnummer. Angiv et dansk postnummer (4 cifre).',
      convertPrices: true,
    },
    en: {
      locale: 'en',
      currency: 'sek',
      countries: ['SE'],
      noteLabel: 'Note (e.g. door code)',
      shippingPlaceholder: 'Enter address for shipping price',
      invalidZip: 'Invalid postal code. Enter a Swedish postal code (5 digits).',
      convertPrices: false,
    },
    sv: {
      locale: 'sv',
      currency: 'sek',
      countries: ['SE'],
      noteLabel: 'Anteckning (t.ex. portkod)',
      shippingPlaceholder: 'Ange adress för fraktpris',
      invalidZip: 'Ogiltigt postnummer. Ange ett svenskt postnummer (5 siffror).',
      convertPrices: false,
    },
  };
  return configs[market] || configs.sv;
}

export function buildProductLineItems(cartItems, market) {
  if (!Array.isArray(cartItems) || cartItems.length === 0) {
    throw new Error('Varukorgen är tom.');
  }

  const cfg = getMarketConfig(market);

  return cartItems.map((item) => {
    let unitAmount = Math.round(Number(item.price) * 100);
    if (!item.title || !unitAmount || unitAmount < 0) {
      throw new Error('Ogiltig produktrad i varukorgen.');
    }

    if (cfg.convertPrices && item.currency !== 'dkk') {
      unitAmount = Math.round(unitAmount * SEK_TO_DKK);
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
        currency: cfg.currency,
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

export async function createEmbeddedCheckoutSession({ cartItems, returnUrl, market }) {
  const stripe = getStripe();
  const cfg = getMarketConfig(market);
  const lineItems = buildProductLineItems(cartItems, market);
  const resolvedReturnUrl = resolveReturnUrl(returnUrl);

  const session = await stripe.checkout.sessions.create({
    ui_mode: 'embedded',
    mode: 'payment',
    payment_method_types: ['card', 'klarna'],
    allow_promotion_codes: true,
    line_items: lineItems,
    locale: cfg.locale,
    return_url: resolvedReturnUrl.includes('{CHECKOUT_SESSION_ID}')
      ? resolvedReturnUrl
      : `${resolvedReturnUrl}${resolvedReturnUrl.includes('?') ? '&' : '?'}session_id={CHECKOUT_SESSION_ID}`,
    shipping_address_collection: { allowed_countries: cfg.countries },
    phone_number_collection: { enabled: true },
    permissions: {
      update_shipping_details: 'server_only',
    },
    shipping_options: [
      {
        shipping_rate_data: {
          type: 'fixed_amount',
          fixed_amount: { amount: 0, currency: cfg.currency },
          display_name: cfg.shippingPlaceholder,
        },
      },
    ],
    custom_fields: [
      {
        key: 'order_note',
        label: { type: 'custom', custom: cfg.noteLabel },
        type: 'text',
        optional: true,
      },
    ],
    metadata: {
      source: 'soffexpert_embedded',
      market: market || 'sv',
      variant_ids: cartItems.map((item) => item.variant_id).join(','),
    },
  });

  return session;
}

export async function updateCheckoutShipping({ checkoutSessionId, shippingDetails, market }) {
  const stripe = getStripe();
  const cfg = getMarketConfig(market);
  const postalCode = shippingDetails?.address?.postal_code;

  const shippingOptions = buildStripeShippingOptions(postalCode, market);
  if (!shippingOptions) {
    return {
      type: 'error',
      message: cfg.invalidZip,
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
