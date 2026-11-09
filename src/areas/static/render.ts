import type { BrandPalette } from "../../core/brief";
import { escapeHtml, wrapText } from "../../core/text";
import { CREATIVE_FORMATS, type CreativeSpec, type RenderedCreative } from "./types";

/**
 * Template renderer. Produces an SVG from a spec and the brand palette, with
 * no browser. In production the same specs can drive Figma/Canva templates
 * or an HTML-to-image service; the point is that the layout is data, so the
 * checks in checks.ts can run before a human ever opens the file.
 */

const AVG_CHAR_WIDTH = 0.55; // of font size, for a geometric sans

export function renderCreative(spec: CreativeSpec, palette: BrandPalette, brandName: string): RenderedCreative {
  const { width, height } = CREATIVE_FORMATS[spec.format];
  // Scale typography off the shorter side so landscape and story both fit.
  const base = Math.min(width, height);
  const bg = palette[spec.colours.background];
  const text = palette[spec.colours.text];
  const accent = palette[spec.colours.accent];
  const font = escapeHtml(palette.fontFamily);
  const margin = Math.round(base * 0.07);
  const isStory = spec.format === "story";
  // Stories/Reels UI covers roughly the top 14% and bottom 20% of the frame.
  const safeTop = isStory ? Math.round(height * 0.14) : margin;
  const safeBottom = isStory ? Math.round(height * 0.8) : height - margin;
  const contentWidth = width - 2 * margin;
  const textBoxes: RenderedCreative["textBoxes"] = [];
  const parts: string[] = [];

  const textWidth = (lines: string[], fontSize: number) => Math.round(Math.max(...lines.map((l) => l.length), 0) * fontSize * AVG_CHAR_WIDTH);

  parts.push(`<rect width="${width}" height="${height}" fill="${bg}"/>`);
  if (spec.imageStyle === "photo") {
    parts.push(
      `<defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${bg}" stop-opacity="0.15"/><stop offset="1" stop-color="${bg}" stop-opacity="0.95"/></linearGradient></defs>`,
    );
    parts.push(`<rect width="${width}" height="${height}" fill="${shade(bg, -12)}"/>`);
    parts.push(`<rect width="${width}" height="${height}" fill="url(#g)"/>`);
    const lfs = Math.round(base * 0.02);
    parts.push(`<text x="${margin}" y="${safeTop + lfs}" font-family="${font}" font-size="${lfs}" fill="${text}" opacity="0.55">${escapeHtml(`[photo] ${truncateForLabel(spec.imagePrompt)}`)}</text>`);
  }

  let cursorY = safeTop + Math.round(base * 0.06);

  if (spec.badge) {
    const fs = Math.round(base * 0.03);
    const w = Math.round(spec.badge.length * fs * AVG_CHAR_WIDTH + fs * 1.6);
    parts.push(`<rect x="${margin}" y="${cursorY}" rx="${fs}" width="${w}" height="${fs * 1.9}" fill="${accent}"/>`);
    parts.push(`<text x="${margin + fs * 0.8}" y="${cursorY + fs * 1.3}" font-family="${font}" font-weight="700" font-size="${fs}" fill="${palette.text}">${escapeHtml(spec.badge)}</text>`);
    textBoxes.push({ x: margin, y: cursorY, width: w, height: fs * 1.9, role: "badge" });
    cursorY += Math.round(fs * 3.2);
  }

  if (spec.layout === "split-contrast") {
    const seam = Math.round(width / 2);
    parts.push(`<rect x="0" y="0" width="${seam}" height="${height}" fill="${shade(bg, -25)}" opacity="0.6"/>`);
    parts.push(`<line x1="${seam}" y1="0" x2="${seam}" y2="${height}" stroke="${accent}" stroke-width="6"/>`);
  }

  if (spec.layout === "stat-led" && spec.stat) {
    const fs = Math.round(base * 0.2);
    parts.push(`<text x="${margin}" y="${cursorY + fs * 0.95}" font-family="${font}" font-weight="800" font-size="${fs}" fill="${accent}">${escapeHtml(spec.stat.value)}</text>`);
    textBoxes.push({ x: margin, y: cursorY, width: textWidth([spec.stat.value], fs * 1.1), height: fs * 1.05, role: "stat" });
    cursorY += Math.round(fs * 1.15);
    const lfs = Math.round(base * 0.042);
    const lines = wrapText(spec.stat.label, Math.floor(contentWidth / (lfs * AVG_CHAR_WIDTH)));
    const top = cursorY;
    for (const line of lines) {
      parts.push(`<text x="${margin}" y="${cursorY + lfs}" font-family="${font}" font-size="${lfs}" fill="${text}">${escapeHtml(line)}</text>`);
      cursorY += Math.round(lfs * 1.3);
    }
    textBoxes.push({ x: margin, y: top, width: textWidth(lines, lfs), height: cursorY - top, role: "stat-label" });
    cursorY += Math.round(lfs * 0.8);
  }

  // Headline
  const hfs = Math.round(base * (spec.layout === "stat-led" ? 0.05 : isStory ? 0.072 : 0.072));
  const quote = spec.layout === "quote";
  const headlineLines = wrapText(quote ? `“${spec.headline}”` : spec.headline, Math.floor(contentWidth / (hfs * AVG_CHAR_WIDTH)));
  const headlineTop = cursorY;
  for (const line of headlineLines) {
    parts.push(`<text x="${margin}" y="${cursorY + hfs}" font-family="${font}" font-weight="${quote ? 500 : 800}" font-style="${quote ? "italic" : "normal"}" font-size="${hfs}" fill="${text}">${escapeHtml(line)}</text>`);
    cursorY += Math.round(hfs * 1.15);
  }
  textBoxes.push({ x: margin, y: headlineTop, width: textWidth(headlineLines, hfs), height: cursorY - headlineTop, role: "headline" });
  cursorY += Math.round(hfs * 0.45);

  // CTA pill anchored to the bottom safe zone; computed first so the subline can avoid it.
  const cfs = Math.round(base * 0.034);
  const ctaW = Math.round(spec.cta.length * cfs * AVG_CHAR_WIDTH + cfs * 2.4);
  const ctaH = Math.round(cfs * 2.2);
  const ctaY = safeBottom - ctaH;

  if (spec.subline) {
    const sfs = Math.round(base * 0.034);
    const sublineLines = wrapText(spec.subline, Math.floor(contentWidth / (sfs * AVG_CHAR_WIDTH)));
    const lineH = Math.round(sfs * 1.35);
    const available = ctaY - Math.round(cfs) - cursorY;
    const fit = Math.max(0, Math.floor(available / lineH));
    const shown = sublineLines.slice(0, fit);
    const top = cursorY;
    for (const line of shown) {
      parts.push(`<text x="${margin}" y="${cursorY + sfs}" font-family="${font}" font-size="${sfs}" fill="${text}" opacity="0.92">${escapeHtml(line)}</text>`);
      cursorY += lineH;
    }
    if (shown.length) textBoxes.push({ x: margin, y: top, width: textWidth(shown, sfs), height: cursorY - top, role: "subline" });
    if (shown.length < sublineLines.length) {
      // Record the dropped lines as an overflow box so checks flag it instead of silently clipping.
      textBoxes.push({ x: margin, y: height, width: contentWidth, height: (sublineLines.length - shown.length) * lineH, role: "subline-overflow" });
    }
  }

  parts.push(`<rect x="${margin}" y="${ctaY}" rx="${ctaH / 2}" width="${ctaW}" height="${ctaH}" fill="${accent}"/>`);
  parts.push(`<text x="${margin + cfs * 1.2}" y="${ctaY + cfs * 1.45}" font-family="${font}" font-weight="700" font-size="${cfs}" fill="${palette.text}">${escapeHtml(spec.cta)}</text>`);
  textBoxes.push({ x: margin, y: ctaY, width: ctaW, height: ctaH, role: "cta" });

  // Logo lock-up (text wordmark placeholder) bottom right
  const lfs2 = Math.round(base * 0.03);
  const logoW = Math.round(brandName.length * lfs2 * AVG_CHAR_WIDTH);
  parts.push(`<text x="${width - margin - logoW}" y="${ctaY + cfs * 1.45}" font-family="${font}" font-weight="800" font-size="${lfs2}" fill="${text}" data-role="logo">${escapeHtml(brandName.toUpperCase())}</text>`);
  textBoxes.push({ x: width - margin - logoW, y: ctaY, width: logoW, height: ctaH, role: "logo" });

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" data-creative-id="${escapeHtml(spec.id)}" data-layout="${spec.layout}">${parts.join("")}</svg>`;
  return { spec, svg, width, height, textBoxes };
}

/** Rasterise to PNG with resvg. Returns null if the native module is unavailable. */
export async function renderPng(svg: string): Promise<Uint8Array | null> {
  try {
    const { Resvg } = await import("@resvg/resvg-js");
    const resvg = new Resvg(svg, { font: { loadSystemFonts: true, defaultFontFamily: "Arial" } });
    return resvg.render().asPng();
  } catch {
    return null;
  }
}

export function shade(hex: string, percent: number): string {
  const n = parseInt(hex.slice(1), 16);
  const r = clamp255(((n >> 16) & 0xff) + Math.round((255 * percent) / 100));
  const g = clamp255(((n >> 8) & 0xff) + Math.round((255 * percent) / 100));
  const b = clamp255((n & 0xff) + Math.round((255 * percent) / 100));
  return `#${[r, g, b].map((v) => v.toString(16).padStart(2, "0")).join("")}`;
}

function clamp255(v: number): number {
  return Math.max(0, Math.min(255, v));
}

function truncateForLabel(text: string): string {
  return text.length > 70 ? `${text.slice(0, 69)}…` : text;
}
