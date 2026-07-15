const SEK_TO_DKK = Number(process.env.SEK_TO_DKK_RATE || 0.63);

export function parseZipCode(zipCode) {
  const digits = String(zipCode || '').replace(/\D/g, '');
  if (digits.length < 4) return null;
  if (digits.length >= 5) return parseInt(digits.slice(0, 5), 10);
  return parseInt(digits.slice(0, 4), 10);
}

function isSkane(zipCode) {
  const zip = parseZipCode(zipCode);
  if (zip === null || zip > 99999) return null;
  return zip >= 20000 && zip <= 29999;
}

function isCopenhagenArea(zipCode) {
  const zip = parseZipCode(zipCode);
  if (zip === null || zip > 9999) return null;
  return zip >= 1000 && zip <= 2999;
}

function shippingOption(displayName, amount, currency, carry) {
  const amountMinor = Math.round(amount * 100);

  return {
    shipping_rate_data: {
      type: 'fixed_amount',
      fixed_amount: {
        amount: amountMinor,
        currency,
      },
      display_name: displayName,
      metadata: {
        type: 'shipping',
        carry: carry ? 'true' : 'false',
      },
    },
  };
}

function convertSekToDkk(amountSek) {
  return Math.round(amountSek * SEK_TO_DKK);
}

/** Stripe shipping_options baserat på postnummer och marknad. */
export function buildStripeShippingOptions(postalCode, market) {
  market = market || 'sv';

  if (market === 'da') {
    const cph = isCopenhagenArea(postalCode);
    if (cph === null) return null;

    if (cph) {
      return [
        shippingOption('Hjemlevering (København)', 1600, 'dkk', false),
      ];
    }

    return [
      shippingOption('Hjemlevering', 2000, 'dkk', false),
    ];
  }

  const skane = isSkane(postalCode);
  if (skane === null) return null;

  if (skane) {
    return [
      shippingOption('Hemleverans (EXPRESS)', 0, 'sek', false),
      shippingOption('Hemleverans + inbärning (EXPRESS)', 349, 'sek', true),
    ];
  }

  return [
    shippingOption('Hemleverans till tomtgräns [DHL]', 899, 'sek', false),
    shippingOption('Hemleverans till tomtgräns (+inbärning) [DHL]', 1798, 'sek', true),
  ];
}
