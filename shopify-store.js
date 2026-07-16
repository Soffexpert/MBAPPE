export function getAdminStoreHost(store) {
  const cleaned = String(store || '')
    .replace(/^https?:\/\//, '')
    .replace(/\/$/, '');

  if (!cleaned) {
    throw new Error('SHOPIFY_STORE saknas.');
  }

  if (cleaned.endsWith('.myshopify.com')) {
    return cleaned;
  }

  const shopName = cleaned.split('.')[0];
  return `${shopName}.myshopify.com`;
}
