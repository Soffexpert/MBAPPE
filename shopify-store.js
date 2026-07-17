/**
 * Normalize SHOPIFY_STORE to admin host (*.myshopify.com).
 * Never derive this from a custom domain like soffexpert.se — that becomes
 * soffexpert.myshopify.com which is the WRONG shop.
 */
export function getAdminStoreHost(store) {
  const cleaned = String(store || '')
    .replace(/^https?:\/\//, '')
    .replace(/\/$/, '')
    .trim()
    .toLowerCase();

  if (!cleaned) {
    throw new Error('SHOPIFY_STORE saknas.');
  }

  if (cleaned.endsWith('.myshopify.com')) {
    return cleaned;
  }

  // Bare shop handle: "pgu0gu-7z"
  if (!cleaned.includes('.')) {
    return `${cleaned}.myshopify.com`;
  }

  throw new Error(
    `SHOPIFY_STORE måste vara din myshopify-shop (t.ex. pgu0gu-7z.myshopify.com), inte custom domain "${cleaned}".`
  );
}
