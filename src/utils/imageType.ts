/** Raster image types we are willing to serve through the proxy (no SVG/HTML: they can run script when opened directly). */
export const SERVABLE_IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/avif', 'image/apng'];

/** Detect a raster image type from its first bytes, or '' when it is not one we serve. */
export function sniffImageType(buf: Buffer): string {
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (buf.length >= 6 && (buf.subarray(0, 6).toString('latin1') === 'GIF87a' || buf.subarray(0, 6).toString('latin1') === 'GIF89a')) return 'image/gif';
  if (buf.length >= 12 && buf.subarray(0, 4).toString('latin1') === 'RIFF' && buf.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
  if (buf.length >= 12 && buf.subarray(4, 8).toString('latin1') === 'ftyp' && /^(avif|avis)/.test(buf.subarray(8, 12).toString('latin1'))) return 'image/avif';
  return '';
}

/** The content type to serve: the upstream header if it is a servable raster type, else what the bytes say, else ''. */
export function resolveServableImageType(headerValue: string | undefined, body: Buffer): string {
  const declared = (headerValue || '').split(';')[0].trim().toLowerCase();
  const sniffed = sniffImageType(body);
  if (!sniffed) return ''; // bytes must really be an image, whatever the header claims
  return SERVABLE_IMAGE_TYPES.includes(declared) ? declared : sniffed;
}
