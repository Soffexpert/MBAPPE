import { getShopifyAccessToken } from './shopify-auth.js';
import { getAdminStoreHost } from './shopify-store.js';

const API_VERSION = '2025-01';

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
  const market = session.metadata?.market || 'sv';

  if (market === 'da') {
    if (shippingCost >= 1700) return '(DHL Express) Hjemlevering + indbæring';
    if (shippingCost >= 1200) return '(DHL Express) Hjemlevering';
    return 'Fragt';
  }

  if (shippingCost === 0) return 'Hemleverans (EXPRESS)';
  if (shippingCost >= 1500) return 'Hemleverans till tomtgräns (+inbärning) [DHL]';
  if (shippingCost >= 800) return 'Hemleverans till tomtgräns [DHL]';
  if (shippingCost >= 300) return 'Hemleverans + inbärning (EXPRESS)';
  return 'Frakt';
}

async function adminFetch(adminStore, token, path, { method = 'GET', body } = {}) {
  const response = await fetch(`https://${adminStore}/admin/api/${API_VERSION}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      'X-Shopify-Access-Token': token,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await response.json().catch(() => ({}));
  return { response, data };
}

async function sendOrderConfirmationEmail(adminStore, token, orderId) {
  const { response, data } = await adminFetch(adminStore, token, '/graphql.json', {
    method: 'POST',
    body: {
      query: `
        mutation OrderSendConfirmationEmail($orderId: ID!) {
          orderSendConfirmationEmail(id: $orderId) {
            userErrors { field message }
          }
        }
      `,
      variables: { orderId: `gid://shopify/Order/${orderId}` },
    },
  });

  const userErrors = data.data?.orderSendConfirmationEmail?.userErrors || [];
  if (!response.ok || data.errors?.length || userErrors.length) {
    throw new Error(JSON.stringify(data));
  }
}

async function sendOrderInvoiceEmail(adminStore, token, orderId, email, orderName) {
  const { response, data } = await adminFetch(
    adminStore,
    token,
    `/orders/${orderId}/send_invoice.json`,
    {
      method: 'POST',
      body: {
        order_invoice: {
          to: email,
          subject: `Orderbekräftelse ${orderName}`,
          custom_message:
            'Tack för din beställning hos SoffExpert! Här är en sammanfattning av din order.',
        },
      },
    }
  );

  if (!response.ok) {
    throw new Error(data.errors ? JSON.stringify(data.errors) : 'Kunde inte skicka orderfaktura.');
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

async function buildLineItemsFromStripe(stripe, session) {
  const lineItemsResult = await stripe.checkout.sessions.listLineItems(session.id, {
    expand: ['data.price.product'],
  });

  const fallbackVariantIds = String(session.metadata?.variant_ids || '')
    .split(',')
    .map((id) => id.trim())
    .filter(Boolean);

  const orderLineItems = [];
  const productIds = new Set(
    String(session.metadata?.product_ids || '')
      .split(',')
      .map((id) => id.trim())
      .filter(Boolean)
  );
  let productIndex = 0;

  for (const item of lineItemsResult.data) {
    const product = item.price?.product;
    const title = (typeof product === 'object' && product?.name) || item.description || 'Produkt';

    if (typeof product === 'object' && product?.metadata?.type === 'shipping') continue;

    let variantId =
      (typeof product === 'object' && product?.metadata?.variant_id) ||
      fallbackVariantIds[productIndex] ||
      '';

    const productIdMeta =
      (typeof product === 'object' && product?.metadata?.product_id) || '';
    if (productIdMeta) productIds.add(String(productIdMeta));

    if (typeof product === 'object' || fallbackVariantIds[productIndex]) {
      productIndex += 1;
    }

    const qty = Number(item.quantity) || 1;
    const unitPrice = formatMoney((item.amount_total || 0) / qty / 100);

    if (variantId && Number(variantId) > 0) {
      orderLineItems.push({
        variant_id: Number(variantId),
        quantity: qty,
        price: unitPrice,
        _title: title,
        _product_id: productIdMeta || null,
      });
    } else {
      orderLineItems.push({
        title,
        quantity: qty,
        price: unitPrice,
        requires_shipping: true,
        _title: title,
        _product_id: productIdMeta || null,
      });
    }
  }

  if (!orderLineItems.length && fallbackVariantIds.length) {
    for (const variantId of fallbackVariantIds) {
      orderLineItems.push({
        variant_id: Number(variantId),
        quantity: 1,
      });
    }
  }

  return { orderLineItems, productIds: [...productIds] };
}

function stripInternalFields(lineItems) {
  return lineItems.map(({ _title, _product_id, ...rest }) => rest);
}

async function resolveProductIdsFromVariants(adminStore, token, lineItems, knownIds) {
  const ids = new Set(knownIds.map(String));
  for (const item of lineItems) {
    if (item._product_id) ids.add(String(item._product_id));
    if (!item.variant_id) continue;
    try {
      const { response, data } = await adminFetch(
        adminStore,
        token,
        `/variants/${item.variant_id}.json`
      );
      if (response.ok && data.variant?.product_id) {
        ids.add(String(data.variant.product_id));
      }
    } catch (error) {
      console.warn('variant lookup failed', item.variant_id, error.message);
    }
  }
  return [...ids];
}

/** Set product status to draft (= olistad / hidden from storefront). */
export async function unlistProductsAfterPurchase(adminStore, token, productIds) {
  const results = [];
  for (const productId of productIds) {
    if (!productId) continue;
    try {
      const { response, data } = await adminFetch(
        adminStore,
        token,
        `/products/${productId}.json`,
        {
          method: 'PUT',
          body: {
            product: {
              id: Number(productId),
              status: 'draft',
            },
          },
        }
      );
      if (!response.ok) {
        console.error('unlist product failed', productId, JSON.stringify(data));
        results.push({ productId, ok: false, error: data.errors || data });
      } else {
        console.log('Product set to draft/olistad:', productId);
        results.push({ productId, ok: true, status: 'draft' });
      }
    } catch (error) {
      console.error('unlist product error', productId, error.message);
      results.push({ productId, ok: false, error: error.message });
    }
  }
  return results;
}

async function tryCompleteDraftOrder(adminStore, token, session) {
  const draftId = session.metadata?.shopify_checkout_token;
  if (!draftId || !/^\d+$/.test(String(draftId))) return null;

  const shippingAddress = getAddress(session);
  const customerEmail = session.customer_details?.email;
  const orderNote = getOrderNote(session);

  // Refresh draft with final customer data before completing
  const draftUpdate = {
    draft_order: {
      note: [
        'Betald via Stripe Embedded Checkout (Klarna/kort).',
        orderNote ? `Kundanteckning: ${orderNote}` : '',
        `Stripe session: ${session.id}`,
      ]
        .filter(Boolean)
        .join('\n'),
      tags: 'stripe,embedded-checkout',
    },
  };
  if (customerEmail) draftUpdate.draft_order.email = customerEmail;
  if (shippingAddress) {
    draftUpdate.draft_order.shipping_address = shippingAddress;
    draftUpdate.draft_order.billing_address = shippingAddress;
  }

  await adminFetch(adminStore, token, `/draft_orders/${draftId}.json`, {
    method: 'PUT',
    body: draftUpdate,
  }).catch((error) => {
    console.warn('draft update before complete failed:', error.message);
  });

  const { response, data } = await adminFetch(
    adminStore,
    token,
    `/draft_orders/${draftId}/complete.json?payment_pending=false`,
    { method: 'PUT' }
  );

  if (!response.ok) {
    console.warn('draft complete failed, will create order instead:', JSON.stringify(data));
    return null;
  }

  const orderId = data.draft_order?.order_id;
  if (!orderId) {
    console.warn('draft complete returned no order_id', JSON.stringify(data));
    return null;
  }

  const orderRes = await adminFetch(adminStore, token, `/orders/${orderId}.json`);
  if (!orderRes.response.ok || !orderRes.data.order) {
    console.warn('could not load completed draft order', orderId);
    return null;
  }

  console.log('Order created by completing draft', draftId, '→', orderRes.data.order.name);
  return orderRes.data.order;
}

async function createOrderViaRest(adminStore, token, session, orderLineItems) {
  const shippingAddress = getAddress(session);
  const orderNote = getOrderNote(session);
  const shippingTotal = (session.total_details?.amount_shipping || 0) / 100;
  const discountTotal = (session.total_details?.amount_discount || 0) / 100;
  const shippingLabel = getShippingLabel(session);
  const customerEmail = session.customer_details?.email;

  // Do NOT send currency — many shops reject it and the whole create fails.
  const orderPayload = {
    order: {
      email: customerEmail,
      phone: session.customer_details?.phone || undefined,
      financial_status: 'paid',
      send_receipt: false,
      note: [
        'Betald via Stripe Embedded Checkout (Klarna/kort).',
        orderNote ? `Kundanteckning: ${orderNote}` : '',
        discountTotal > 0 ? `Rabatt tillämpad: -${formatMoney(discountTotal)}` : '',
        `Vald frakt: ${shippingLabel}`,
        `Stripe session: ${session.id}`,
      ]
        .filter(Boolean)
        .join('\n'),
      line_items: stripInternalFields(orderLineItems),
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
          amount: formatMoney((session.amount_total || 0) / 100),
          gateway: 'Stripe',
        },
      ],
      tags: 'stripe,embedded-checkout',
    },
  };

  if (customerEmail) {
    orderPayload.order.customer = {
      email: customerEmail,
      first_name:
        shippingAddress?.first_name || session.customer_details?.name?.split(/\s+/)[0] || '',
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

  let { response, data } = await adminFetch(adminStore, token, '/orders.json', {
    method: 'POST',
    body: orderPayload,
  });

  // Retry with custom line items (title) if variant_id rejected
  if (!response.ok) {
    console.error('Shopify order create failed (attempt 1):', JSON.stringify(data));
    const customItems = orderLineItems.map((item) => ({
      title: item._title || 'Produkt',
      quantity: item.quantity || 1,
      price: item.price || '0.00',
      requires_shipping: true,
    }));
    orderPayload.order.line_items = customItems;
    ({ response, data } = await adminFetch(adminStore, token, '/orders.json', {
      method: 'POST',
      body: orderPayload,
    }));
  }

  if (!response.ok) {
    console.error('Shopify order create failed (attempt 2):', JSON.stringify(data));
    throw new Error(
      data.errors ? JSON.stringify(data.errors) : 'Kunde inte skapa Shopify-order.'
    );
  }

  return data.order;
}

export async function createShopifyOrderFromSession(stripe, session) {
  const { store, token } = await getShopifyAccessToken();
  const adminStore = getAdminStoreHost(store);

  const { orderLineItems, productIds: metaProductIds } = await buildLineItemsFromStripe(
    stripe,
    session
  );

  if (!orderLineItems.length) {
    throw new Error('Inga produktrader att skapa order från.');
  }

  // 1) Prefer completing existing abandoned draft (most reliable when present)
  let order = await tryCompleteDraftOrder(adminStore, token, session);

  // 2) Otherwise create a paid order via REST
  if (!order) {
    order = await createOrderViaRest(adminStore, token, session, orderLineItems);
  }

  // 3) Unlist bought products (draft = olistad / hidden)
  try {
    const productIds = await resolveProductIdsFromVariants(
      adminStore,
      token,
      orderLineItems,
      metaProductIds
    );
    if (productIds.length) {
      await unlistProductsAfterPurchase(adminStore, token, productIds);
    } else {
      console.warn('No product_ids to unlist for session', session.id);
    }
  } catch (error) {
    console.error('unlist after purchase failed:', error.message || error);
  }

  // 4) Email — never fail the order if mail fails
  try {
    await notifyCustomerAboutOrder(adminStore, token, order);
  } catch (error) {
    console.error('notifyCustomerAboutOrder:', error.message || error);
  }

  return order;
}
