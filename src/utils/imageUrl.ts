/**
 * Re-wrap a stored item imageUrl for the current API host.
 * - data:image/... (user-uploaded photo or scan thumbnail) is returned unchanged: it is not fetchable
 *   through the https-only image proxy and needs no proxy.
 * - an old proxy URL (any host) is unwrapped and re-wrapped with the current host
 * - any other URL is wrapped through the current host's proxy
 */
export function rewrapImageUrl(imageUrl: string | undefined | null, currentBaseUrl: string): string | undefined {
  if (!imageUrl) return undefined;
  if (/^data:image\//i.test(imageUrl)) return imageUrl;
  const proxyMatch = imageUrl.match(/\/img\/image-proxy\?url=(.+)$/);
  let raw = imageUrl;
  if (proxyMatch) {
    try {
      raw = decodeURIComponent(proxyMatch[1]);
    } catch {
      raw = proxyMatch[1];
    }
  }
  return `${currentBaseUrl}/img/image-proxy?url=${encodeURIComponent(raw)}`;
}
