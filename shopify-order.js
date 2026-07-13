import { getShopifyAccessToken } from './shopify-auth.js';
import { getAdminStoreHost } from './shopify-store.js';

function formatMoney(amount) {
  return Number(amount).toFixed(2);
}

function getOrderNote(session) {
  const noteField = session.custom_fields?.find((field) => field.key === 'order_note');
  return noteField?.text?.value || '';
}

function getAddress(session) {
  const shipping =
    session.shipping_details || session.collected_information?.shipping_details;
  const address = shipping?.address || session.customer_details?.address;
  const name = shipping?.name || session.customer_details?.name || '';
  const parts = name.trim().split(/\s+/);

  if (!address) return null;

  return {
    first_name: parts[0] || '',
    last_name: parts.slice(1).join(' ') || '',
    address1: address.line1 || '',
    address2: address.line2 || '',
    city: address.city || '',
    zip: address.postal_code || '',
    country_code: address.country || 'SE',
    phone: session.customer_details?.phone || '',
  };
}

function getShippingLabel(session) {
  const shippingCost = (session.total_details?.amount_shipping || 0) / 100;
  if (shippingCost === 0) return 'Gratis leverans';
  if (shippingCost >= 1500) return 'Leverans + inbärning (spårbar)';
  if (shippingCost >= 800) return 'Leverans';
  if (shippingCost >= 300) return 'Inbärning';
  return 'Frakt';
}

export async function createShopifyOrderFromSession(stripe, session) {
  const { store, token } = await getShopifyAccessToken();
  const lineItemsResult = await stripe.checkout.sessions.listLineItems(session.id, {
    expand: ['data.price.product'],
  });

  const orderLineItems = [];

  for (const item of lineItemsResult.data) {
    const product = item.price?.product;
    if (!product || typeof product === 'string') continue;
    if (product.metadata?.type === 'shipping') continue;

    const variantId = product.metadata?.variant_id;
    if (!variantId) {
      throw new Error(`Saknar variant_id för produkt: ${product.name}`);
    }

    orderLineItems.push({
      variant_id: Number(variantId),
      quantity: item.quantity,
      price: formatMoney(item.amount_total / item.quantity / 100),
    });
  }

  if (orderLineItems.length === 0) {
    throw new Error('Inga produktrader att skapa order från.');
  }

  const shippingAddress = getAddress(session);
  const orderNote = getOrderNote(session);
  const shippingTotal = (session.total_details?.amount_shipping || 0) / 100;
  const shippingLabel = getShippingLabel(session);

  const orderPayload = {
    order: {
      email: session.customer_details?.email,
      phone: session.customer_details?.phone || undefined,
      financial_status: 'paid',
      send_receipt: true,
      send_fulfillment_receipt: true,
      note: [
        'Betald via Stripe Embedded Checkout (Klarna/kort).',
        orderNote ? `Kundanteckning: ${orderNote}` : '',
        `Vald frakt: ${shippingLabel}`,
        `Stripe session: ${session.id}`,
      ]
        .filter(Boolean)
        .join('\n'),
      line_items: orderLineItems,
      shipping_lines:
        shippingTotal > 0
          ? [
              {
                title: shippingLabel,
                price: formatMoney(shippingTotal),
                code: 'stripe_shipping',
              },
            ]
          : [],
      transactions: [
        {
          kind: 'sale',
          status: 'success',
          amount: formatMoney(session.amount_total / 100),
          gateway: 'Stripe',
        },
      ],
      tags: 'stripe,embedded-checkout',
    },
  };

  if (shippingAddress) {
    orderPayload.order.shipping_address = shippingAddress;
    orderPayload.order.billing_address = shippingAddress;
  }

  const adminStore = getAdminStoreHost(store);
  const response = await fetch(`https://${adminStore}/admin/api/2025-01/orders.json`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Shopify-Access-Token': token,
    },
    body: JSON.stringify(orderPayload),
  });

  const body = await response.json();
  if (!response.ok) {
    throw new Error(body.errors ? JSON.stringify(body.errors) : 'Kunde inte skapa Shopify-order.');
  }

  return body.order;
}
