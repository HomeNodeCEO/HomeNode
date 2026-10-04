// Printed form rules can join typed text and make OCR discard the whole region.
// Only remove continuous dark runs spanning at least 20% of a page; ordinary
// glyphs, whitespace, color, vertical rules, and the immutable PDF are preserved.
export function removeLongHorizontalRules(pixels, width, height) {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0
    || width * height > 6_000_000 || pixels.length !== width * height * 4) {
    throw new Error("document_ocr_pixel_limit_exceeded");
  }
  let removedPixels = 0;
  for (let y = 0; y < height; y += 1) {
    let start = -1;
    for (let x = 0; x <= width; x += 1) {
      const offset = (y * width + x) * 4;
      const dark = x < width && pixels[offset] < 100 && pixels[offset + 1] < 100 && pixels[offset + 2] < 100;
      if (dark && start < 0) start = x;
      if (!dark && start >= 0) {
        if (x - start > width * 0.2) {
          for (let column = start; column < x; column += 1) {
            const pixel = (y * width + column) * 4;
            pixels[pixel] = pixels[pixel + 1] = pixels[pixel + 2] = 255;
          }
          removedPixels += x - start;
        }
        start = -1;
      }
    }
  }
  return removedPixels;
}
