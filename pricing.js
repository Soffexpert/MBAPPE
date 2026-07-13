export function parseZipCode(zipCode) {
  const digits = String(zipCode || '').replace(/\D/g, '');
  if (digits.length < 5) return null;
  return parseInt(digits.slice(0, 5), 10);
}

function isSkane(zipCode) {
  const zip = parseZipCode(zipCode);
  if (zip === null) return null;
  return zip >= 20000 && zip <= 29999;
}

function shippingOption(displayName, amountSek, carry) {
  return {
    shipping_rate_data: {
      type: 'fixed_amount',
      fixed_amount: {
        amount: Math.round(amountSek * 100),
        currency: 'sek',
      },
      display_name: displayName,
      metadata: {
        type: 'shipping',
        carry: carry ? 'true' : 'false',
      },
    },
  };
}

/** Stripe shipping_options baserat på postnummer i leveransadressen. */
export function buildStripeShippingOptions(postalCode) {
  const skane = isSkane(postalCode);
  if (skane === null) {
    return null;
  }

  if (skane) {
    return [
      shippingOption('Hemleverans (EXPRESS)', 0, false),
      shippingOption('Hemleverans + inbärning (EXPRESS)', 349, true),
    ];
  }

  return [
    shippingOption('Hemleverans till tomtgräns [DHL]', 899, false),
    shippingOption('Hemleverans till tomtgräns (+inbärning) [DHL]', 1798, true),
  ];
}
