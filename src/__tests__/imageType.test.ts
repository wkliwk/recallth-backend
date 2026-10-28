import { sniffImageType, resolveServableImageType } from '../utils/imageType';

describe('image type detection', () => {
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0]);
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
  const gif = Buffer.from('GIF89a......');
  const webp = Buffer.concat([Buffer.from('RIFF'), Buffer.from([0, 0, 0, 0]), Buffer.from('WEBP')]);
  const avif = Buffer.concat([Buffer.from([0, 0, 0, 0x1c]), Buffer.from('ftypavif')]);

  it('recognises raster images from their bytes', () => {
    expect(sniffImageType(jpeg)).toBe('image/jpeg');
    expect(sniffImageType(png)).toBe('image/png');
    expect(sniffImageType(gif)).toBe('image/gif');
    expect(sniffImageType(webp)).toBe('image/webp');
    expect(sniffImageType(avif)).toBe('image/avif');
  });
  it('rejects HTML, SVG and short buffers', () => {
    expect(sniffImageType(Buffer.from('<html></html>'))).toBe('');
    expect(sniffImageType(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'))).toBe('');
    expect(sniffImageType(Buffer.from([0xff]))).toBe('');
  });
  it('requires real image bytes whatever the header claims', () => {
    expect(resolveServableImageType('image/png', Buffer.from('<html>'))).toBe('');
    expect(resolveServableImageType('text/html', png)).toBe('image/png');
    expect(resolveServableImageType('image/jpeg; charset=x', jpeg)).toBe('image/jpeg');
    expect(resolveServableImageType('image/svg+xml', png)).toBe('image/png');
    expect(resolveServableImageType(undefined, Buffer.from('plain'))).toBe('');
  });
});
