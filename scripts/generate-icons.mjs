// Zero-dependency PNG icon generator for the 서재 PWA.
// Draws the app's "bookmark ribbon" mark (same shape as .ribbon-fill in index.html)
// on a graphite background, encodes raw RGBA -> PNG manually (no canvas/deps).
import { deflateSync } from "node:zlib";
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ICONS_DIR = join(__dirname, "..", "icons");
mkdirSync(ICONS_DIR, { recursive: true });

/* ---------- palette (mirrors :root tokens in index.html) ---------- */
const BG_DEEP = [168, 95, 48];   // --accent-500
const BG_LIGHT = [201, 122, 69]; // --accent-400
const INK_700 = [172, 108, 65];  // mid-tone edge highlight between bg shades
const CREAM_LIGHT = [255, 250, 246]; // near-white cream (ribbon top)
const CREAM_DARK = [241, 230, 216];  // warm cream (ribbon bottom)

const lerp = (a, b, t) => a + (b - a) * t;
const lerpColor = (c1, c2, t) => [lerp(c1[0], c2[0], t), lerp(c1[1], c2[1], t), lerp(c1[2], c2[2], t)];

/* ---------- geometry helpers ---------- */
function insideRoundedRect(x, y, halfW, halfH, r) {
  const qx = Math.abs(x) - (halfW - r);
  const qy = Math.abs(y) - (halfH - r);
  if (qx <= 0 && qy <= 0) return true;
  const ex = Math.max(qx, 0), ey = Math.max(qy, 0);
  return ex * ex + ey * ey <= r * r;
}

function pointInPolygon(x, y, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    const intersect = yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

function arcPoints(cx, cy, r, startDeg, endDeg, segments) {
  const pts = [];
  for (let i = 0; i <= segments; i++) {
    const t = startDeg + ((endDeg - startDeg) * i) / segments;
    const rad = (t * Math.PI) / 180;
    pts.push([cx + r * Math.cos(rad), cy + r * Math.sin(rad)]);
  }
  return pts;
}

// Bookmark-ribbon polygon (matches .ribbon-fill's clip-path notch), centered at origin.
// halfW/topY/botY in same units as the canvas (size S), cr = top corner radius.
function ribbonPolygon(halfW, topY, botY, cr, notch) {
  const poly = [];
  poly.push(...arcPoints(-halfW + cr, topY + cr, cr, 180, 270, 6)); // top-left rounded corner
  poly.push(...arcPoints(halfW - cr, topY + cr, cr, -90, 0, 6)); // top-right rounded corner
  poly.push([halfW, botY]); // right edge down
  poly.push([0, botY + notch]); // notch point (juts downward)
  poly.push([-halfW, botY]); // left edge back up
  return poly;
}

/* ---------- rasterizer (supersampled coverage AA) ---------- */
function render(size, draw, { fullBleed = false, opaque = false } = {}) {
  const SS = 4; // supersample factor
  const hs = size / 2;
  const buf = Buffer.alloc(size * size * 4);
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const x = px + (sx + 0.5) / SS - hs;
          const y = py + (sy + 0.5) / SS - hs;
          const c = draw(x, y, hs);
          r += c[0]; g += c[1]; b += c[2]; a += c[3];
        }
      }
      const n = SS * SS;
      const idx = (py * size + px) * 4;
      buf[idx] = Math.round(r / n);
      buf[idx + 1] = Math.round(g / n);
      buf[idx + 2] = Math.round(b / n);
      buf[idx + 3] = opaque ? 255 : Math.round(a / n);
    }
  }
  return buf;
}

function makeDrawFn({ size, fullBleed, cornerFrac, ribbonWidthFrac, ribbonHeightFrac, ribbonYOffsetFrac }) {
  const cr = fullBleed ? 0 : size * cornerFrac;
  const bgHalf = size / 2;
  const rHalfW = size * ribbonWidthFrac * 0.5;
  const rTop = -size * ribbonHeightFrac * 0.5 + size * ribbonYOffsetFrac;
  const rBot = size * ribbonHeightFrac * 0.5 + size * ribbonYOffsetFrac;
  const rCr = size * 0.035;
  const notch = size * 0.085;
  const poly = ribbonPolygon(rHalfW, rTop, rBot, rCr, notch);

  return function draw(x, y) {
    const bgOn = fullBleed ? true : insideRoundedRect(x, y, bgHalf, bgHalf, cr);
    if (!bgOn) return [0, 0, 0, 0];
    const t = (y + bgHalf) / size; // 0 top -> 1 bottom
    const bg = lerpColor(BG_LIGHT, BG_DEEP, Math.min(1, t * 1.4));
    if (pointInPolygon(x, y, poly)) {
      const rt = (y - rTop) / (rBot - rTop);
      const fg = lerpColor(CREAM_LIGHT, CREAM_DARK, Math.max(0, Math.min(1, rt)));
      return [fg[0], fg[1], fg[2], 255];
    }
    // subtle 1px inner edge highlight for the rounded (non full-bleed) variants
    if (!fullBleed) {
      const edge = !insideRoundedRect(x, y, bgHalf - 1.1, bgHalf - 1.1, Math.max(0, cr - 1.1));
      if (edge) {
        const line = lerpColor(bg, INK_700, 0.5);
        return [line[0], line[1], line[2], 255];
      }
    }
    return [bg[0], bg[1], bg[2], 255];
  };
}

/* ---------- minimal PNG encoder ---------- */
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, "ascii");
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}
function encodePNG(width, height, rgba, hasAlpha) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const channels = hasAlpha ? 4 : 3;
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = hasAlpha ? 6 : 2;
  const stride = width * channels;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    for (let x = 0; x < width; x++) {
      const srcIdx = (y * width + x) * 4;
      const dstIdx = y * (stride + 1) + 1 + x * channels;
      raw[dstIdx] = rgba[srcIdx];
      raw[dstIdx + 1] = rgba[srcIdx + 1];
      raw[dstIdx + 2] = rgba[srcIdx + 2];
      if (hasAlpha) raw[dstIdx + 3] = rgba[srcIdx + 3];
    }
  }
  const idat = chunk("IDAT", deflateSync(raw, { level: 9 }));
  return Buffer.concat([sig, chunk("IHDR", ihdr), idat, chunk("IEND", Buffer.alloc(0))]);
}

/* ---------- generate the set ---------- */
function writeIcon(name, size, opts) {
  const draw = makeDrawFn({ size, ...opts });
  const rgba = render(size, draw, { fullBleed: opts.fullBleed, opaque: opts.opaque });
  const png = encodePNG(size, size, rgba, !opts.opaque);
  writeFileSync(join(ICONS_DIR, name), png);
  console.log("wrote", name, `${size}x${size}`, opts.opaque ? "(opaque)" : "(alpha)");
}

// standard "any" icons: rounded-square card, transparent corners
writeIcon("icon-192.png", 192, { fullBleed: false, cornerFrac: 0.22, ribbonWidthFrac: 0.34, ribbonHeightFrac: 0.46, ribbonYOffsetFrac: -0.02, opaque: false });
writeIcon("icon-512.png", 512, { fullBleed: false, cornerFrac: 0.22, ribbonWidthFrac: 0.34, ribbonHeightFrac: 0.46, ribbonYOffsetFrac: -0.02, opaque: false });

// maskable icon: full-bleed background, glyph kept inside the ~80% safe-zone circle
writeIcon("icon-maskable-512.png", 512, { fullBleed: true, cornerFrac: 0, ribbonWidthFrac: 0.26, ribbonHeightFrac: 0.36, ribbonYOffsetFrac: -0.01, opaque: false });

// apple-touch-icon: iOS applies its own rounding, wants a full-bleed opaque square
writeIcon("apple-touch-icon.png", 180, { fullBleed: true, cornerFrac: 0, ribbonWidthFrac: 0.3, ribbonHeightFrac: 0.42, ribbonYOffsetFrac: -0.01, opaque: true });

// favicon-sized icon for the browser tab
writeIcon("icon-32.png", 32, { fullBleed: false, cornerFrac: 0.28, ribbonWidthFrac: 0.4, ribbonHeightFrac: 0.5, ribbonYOffsetFrac: -0.02, opaque: false });
