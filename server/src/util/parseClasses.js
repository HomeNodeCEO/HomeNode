export function parseClassFilter(input) {
  const exact = [];
  const lows = [];
  const highs = [];
  const labels = []; // UPPERCASE label tokens like "CONDOMINIUM", "LAND ONLY"

  if (!input) return { exact, lows, highs, labels };

  const parts = String(input).split(/[;,]/);
  for (let raw of parts) {
    let t = raw.trim();
    if (!t) continue;

    // strip matching quotes around labels (e.g., "LAND ONLY")
    if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) {
      t = t.slice(1, -1);
    }

    const range = t.match(/^(\d+)\s*-\s*(\d+)$/);
    if (range) {
      const a = parseInt(range[1], 10);
      const b = parseInt(range[2], 10);
      const lo = Math.min(a, b);
      const hi = Math.max(a, b);
      lows.push(lo);
      highs.push(hi);
    } else if (/^\d+$/.test(t)) {
      exact.push(parseInt(t, 10));
    } else {
      labels.push(t.toUpperCase());
    }
  }

  return { exact, lows, highs, labels };
}
