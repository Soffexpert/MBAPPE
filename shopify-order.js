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
  if (shippingCost === 0) return 'Hemleverans (EXPRESS)';
  if (shippingCost >= 1500) return 'Hemleverans till tomtgräns (+inbärning)';
  if (shippingCost >= 800) return 'Hemleverans till tomtgräns';
  if (shippingCost >= 300) return 'Hemleverans + inbärning (EXPRESS)';
  return 'Frakt';
}

async function sendOrderConfirmationEmail(adminStore, token, orderId) {
  const response = await fetch(`https://${adminStore}/admin/api/2025-01/graphql.json`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Shopify-Access-Token': token,
    },
    body: JSON.stringify({
      query: `
        mutation OrderSendConfirmationEmail($orderId: ID!) {
          orderSendConfirmationEmail(id: $orderId) {
            userErrors {
              field
              message
            }
          }
        }
      `,
      variables: {
        orderId: `gid://shopify/Order/${orderId}`,
      },
    }),
  });

  const result = await response.json();
  const userErrors = result.data?.orderSendConfirmationEmail?.userErrors || [];

  if (!response.ok || result.errors?.length || userErrors.length) {
    throw new Error(JSON.stringify(result));
  }
}

async function sendOrderInvoiceEmail(adminStore, token, orderId, email, orderName) {
  const response = await fetch(
    `https://${adminStore}/admin/api/2025-01/orders/${orderId}/send_invoice.json`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Shopify-Access-Token': token,
      },
      body: JSON.stringify({
        order_invoice: {
          to: email,
          subject: `Orderbekräftelse ${orderName}`,
          custom_message:
            'Tack för din beställning hos SoffExpert! Här är en sammanfattning av din order.',
        },
      }),
    }
  );

  const body = await response.json();
  if (!response.ok) {
    throw new Error(body.errors ? JSON.stringify(body.errors) : 'Kunde inte skicka orderfaktura.');
  }
}

async function notifyCustomerAboutOrder(adminStore, token, order) {
  const email = order.email || order.contact_email;
  if (!email) {
    console.error('Order confirmation skipped: order has no email.');
    return;
  }

  try {
    await sendOrderConfirmationEmail(adminStore, token, order.id);
    console.log('Order confirmation email sent for order', order.id);
    return;
  } catch (error) {
    console.error('Order confirmation email failed, trying invoice email:', error.message);
  }

  try {
    await sendOrderInvoiceEmail(adminStore, token, order.id, email, order.name || `#${order.id}`);
    console.log('Order invoice email sent for order', order.id);
  } catch (error) {
    console.error('Order invoice email failed:', error.message);
  }
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
  const customerEmail = session.customer_details?.email;

  const orderPayload = {
    order: {
      email: customerEmail,
      phone: session.customer_details?.phone || undefined,
      financial_status: 'paid',
      send_receipt: true,
      source_name: 'web',
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

  if (customerEmail) {
    orderPayload.order.customer = {
      email: customerEmail,
      first_name: shippingAddress?.first_name || session.customer_details?.name?.split(/\s+/)[0] || '',
      last_name:
        shippingAddress?.last_name ||
        session.customer_details?.name?.split(/\s+/).slice(1).join(' ') ||
        '',
      phone: session.customer_details?.phone || undefined,
    };
  }

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

  await notifyCustomerAboutOrder(adminStore, token, body.order);

  return body.order;
}
