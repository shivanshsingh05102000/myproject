// client/src/lib/Coord.js
export function clamp01(v) {
  return Math.max(0, Math.min(1, isFinite(v) ? v : 0));
}

/**
 * Convert CSS pixel box (top-left origin) into PDF points (bottom-left origin).
 *
 * @param {{left:number, top:number, width:number, height:number}} cssBox  - pixel positions relative to rendered page element
 * @param {{width:number, height:number}} renderedSize                   - rendered page size in pixels
 * @param {{width:number, height:number}} pageSizePoints                 - PDF page size in points (e.g., A4 ≈ 595 x 842)
 * @returns {{
 *   pdfBox: { x: number, y: number, width: number, height: number },   // in PDF points, origin bottom-left
 *   fractions: { x_frac:number, y_frac:number, w_frac:number, h_frac:number } // normalized [0..1] relative to renderedSize
 * }}
 */
export function cssBoxToPdfPoints(cssBox, renderedSize, pageSizePoints) {
  const left = Number(cssBox.left || 0);
  const top = Number(cssBox.top || 0);
  const widthPx = Number(cssBox.width || 0);
  const heightPx = Number(cssBox.height || 0);

  const rW = Number(renderedSize.width || 1);
  const rH = Number(renderedSize.height || 1);
  const pW = Number(pageSizePoints.width || 1);
  const pH = Number(pageSizePoints.height || 1);

  // avoid division by zero
  const safeRW = rW > 0 ? rW : 1;
  const safeRH = rH > 0 ? rH : 1;
  const safePW = pW > 0 ? pW : 1;
  const safePH = pH > 0 ? pH : 1;

  // fractions (relative to rendered pixels, top-left origin)
  const x_frac = clamp01(left / safeRW);
  const y_frac = clamp01(top / safeRH);
  const w_frac = clamp01(widthPx / safeRW);
  const h_frac = clamp01(heightPx / safeRH);

  // X (left) in PDF points: proportion of page width
  const x_pts = x_frac * safePW;
  const width_pts = w_frac * safePW;

  // Y in PDF is measured from BOTTOM.
  // Convert top-left px -> distance from bottom in px:
  const bottomPx = safeRH - top - heightPx; // may be 0..rH
  const y_frac_from_bottom = clamp01(bottomPx / safeRH);
  const y_pts = y_frac_from_bottom * safePH;
  const height_pts = h_frac * safePH;

  // round to 2 decimals for neatness
  function rnd(v) { return Math.round(v * 100) / 100; }

  return {
    pdfBox: {
      x: rnd(x_pts),
      y: rnd(y_pts),
      width: rnd(width_pts),
      height: rnd(height_pts)
    },
    fractions: {
      x_frac: Number(x_frac.toFixed(6)),
      y_frac: Number(y_frac.toFixed(6)),
      w_frac: Number(w_frac.toFixed(6)),
      h_frac: Number(h_frac.toFixed(6))
    }
  };
}
