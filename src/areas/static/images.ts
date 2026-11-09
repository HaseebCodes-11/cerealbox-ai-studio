import type { BrandPalette } from "../../core/brief";
import { Rng, hashString } from "../../core/rng";
import { escapeHtml } from "../../core/text";
import { shade } from "./render";

/**
 * Background image generation behind a provider interface.
 *  - MockImageProvider draws a deterministic abstract scene in brand tints
 *    (gradients, soft blobs, grain) so creatives look finished offline.
 *  - HttpImageProvider posts the prompt to any image API that returns PNG
 *    bytes (Ideogram, Imagen, Firefly wrappers) and embeds the result.
 * The renderer only ever receives SVG markup, so the composite, the text
 * layer and the checks are identical whichever provider produced the image.
 */
export interface GeneratedImage {
  provider: string;
  prompt: string;
  /** SVG markup to place behind the text layer, sized to the canvas. */
  markup: string;
  /** Present when a raster was produced. */
  dataUri?: string;
}

export interface ImageRequest {
  prompt: string;
  width: number;
  height: number;
  palette: BrandPalette;
  seed?: string;
}

export interface ImageProvider {
  readonly name: string;
  generate(request: ImageRequest): Promise<GeneratedImage>;
}

export class MockImageProvider implements ImageProvider {
  readonly name = "mock-image";

  async generate(request: ImageRequest): Promise<GeneratedImage> {
    return { provider: this.name, prompt: request.prompt, markup: abstractScene(request) };
  }
}

/** Deterministic abstract "photo": warm/cool gradient, soft shapes, grain. */
export function abstractScene({ prompt, width, height, palette, seed }: ImageRequest): string {
  const rng = new Rng(hashString(`${seed ?? ""}:${prompt}`));
  const id = `bg${hashString(prompt).toString(16)}`;
  const warm = /warm|amber|golden|kitchen|lamp|mug|kettle|sunset/i.test(prompt);
  const base = shade(palette.secondary, warm ? -6 : -14);
  const tint = warm ? shade(palette.primary, 10) : shade(palette.secondary, 18);
  const glow = shade(palette.accent, warm ? 10 : -10);
  const blobs: string[] = [];
  const count = rng.int(3, 5);
  for (let i = 0; i < count; i++) {
    const cx = Math.round(rng.float(0.15, 0.85) * width);
    const cy = Math.round(rng.float(0.2, 0.9) * height);
    const r = Math.round(rng.float(0.18, 0.42) * Math.min(width, height));
    const colour = i % 2 === 0 ? tint : glow;
    const opacity = rng.float(0.18, 0.4).toFixed(2);
    blobs.push(`<circle cx="${cx}" cy="${cy}" r="${r}" fill="${colour}" opacity="${opacity}" filter="url(#${id}-blur)"/>`);
  }
  // A horizon band suggests a room or landscape without depicting a person.
  const horizon = Math.round(rng.float(0.55, 0.75) * height);
  return [
    `<g data-background="${escapeHtml(prompt.slice(0, 80))}">`,
    `<defs>`,
    `<linearGradient id="${id}-grad" x1="0" y1="0" x2="0.3" y2="1"><stop offset="0" stop-color="${shade(base, 10)}"/><stop offset="1" stop-color="${shade(base, -18)}"/></linearGradient>`,
    `<filter id="${id}-blur" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="${Math.round(Math.min(width, height) * 0.08)}"/></filter>`,
    `<filter id="${id}-grain"><feTurbulence type="fractalNoise" baseFrequency="0.9" numOctaves="2" seed="${rng.int(1, 999)}"/><feColorMatrix type="saturate" values="0"/><feComponentTransfer><feFuncA type="linear" slope="0.08"/></feComponentTransfer></filter>`,
    `</defs>`,
    `<rect width="${width}" height="${height}" fill="url(#${id}-grad)"/>`,
    ...blobs,
    `<rect x="0" y="${horizon}" width="${width}" height="${height - horizon}" fill="${shade(base, -24)}" opacity="0.55"/>`,
    `<rect width="${width}" height="${height}" filter="url(#${id}-grain)" opacity="0.6"/>`,
    `</g>`,
  ].join("");
}

export interface HttpImageProviderOptions {
  endpoint: string;
  apiKey?: string;
  fetchImpl?: typeof fetch;
  name?: string;
  /** Abort the vendor call after this long (default 60 s). */
  timeoutMs?: number;
  /** Reject images whose decoded size exceeds this (default 12 MB). */
  maxBytes?: number;
}

/** Raster types a browser, resvg and Meta all accept; anything else is refused. */
export const ALLOWED_IMAGE_MIME_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;
export const DEFAULT_IMAGE_TIMEOUT_MS = 60_000;
export const DEFAULT_IMAGE_MAX_BYTES = 12 * 1024 * 1024;

/**
 * Validate a vendor response before it is embedded. Exported so the checks
 * are testable without the provider; returns the data URI or throws.
 */
export function validateImagePayload(body: { imageBase64?: unknown; mimeType?: unknown }, providerName: string, maxBytes = DEFAULT_IMAGE_MAX_BYTES): { dataUri: string; mimeType: string } {
  const mimeType = body.mimeType === undefined ? "image/png" : String(body.mimeType).trim().toLowerCase();
  if (!ALLOWED_IMAGE_MIME_TYPES.has(mimeType)) throw new Error(`Image provider ${providerName} returned unsupported type "${mimeType}"`);
  const b64 = typeof body.imageBase64 === "string" ? body.imageBase64.replace(/\s+/g, "") : "";
  if (!b64) throw new Error(`Image provider ${providerName} returned no image`);
  if (!BASE64.test(b64)) throw new Error(`Image provider ${providerName} returned malformed base64`);
  const decodedBytes = Math.floor((b64.length * 3) / 4) - (b64.endsWith("==") ? 2 : b64.endsWith("=") ? 1 : 0);
  if (decodedBytes > maxBytes) throw new Error(`Image provider ${providerName} returned ${decodedBytes} bytes, above the ${maxBytes} byte limit`);
  return { dataUri: `data:${mimeType};base64,${b64}`, mimeType };
}

/**
 * Generic adapter: POST {prompt,width,height} -> {imageBase64, mimeType}.
 * Wrap a vendor's API in a tiny Edge Function that speaks this shape and the
 * pipeline never needs to know which vendor is behind it.
 */
export class HttpImageProvider implements ImageProvider {
  readonly name: string;
  private readonly fetchImpl: typeof fetch;
  constructor(private readonly options: HttpImageProviderOptions) {
    this.name = options.name ?? "http-image";
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async generate(request: ImageRequest): Promise<GeneratedImage> {
    const timeoutMs = this.options.timeoutMs ?? DEFAULT_IMAGE_TIMEOUT_MS;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let res: Response;
    try {
      res = await this.fetchImpl(this.options.endpoint, {
        method: "POST",
        headers: { "content-type": "application/json", ...(this.options.apiKey ? { authorization: `Bearer ${this.options.apiKey}` } : {}) },
        body: JSON.stringify({ prompt: request.prompt, width: request.width, height: request.height }),
        signal: controller.signal,
      });
    } catch (err) {
      if (controller.signal.aborted) throw new Error(`Image provider ${this.name} timed out after ${timeoutMs} ms`);
      throw err;
    } finally {
      clearTimeout(timer);
    }
    if (!res.ok) throw new Error(`Image provider ${this.name} returned ${res.status}`);
    const body = (await res.json()) as { imageBase64?: unknown; mimeType?: unknown };
    const { dataUri } = validateImagePayload(body, this.name, this.options.maxBytes);
    return {
      provider: this.name,
      prompt: request.prompt,
      dataUri,
      markup: `<g data-background="${escapeHtml(request.prompt.slice(0, 80))}"><image href="${dataUri}" width="${request.width}" height="${request.height}" preserveAspectRatio="xMidYMid slice"/></g>`,
    };
  }
}

export function getImageProvider(env: NodeJS.ProcessEnv = process.env): ImageProvider {
  if (env.IMAGE_PROVIDER_URL) return new HttpImageProvider({ endpoint: env.IMAGE_PROVIDER_URL, apiKey: env.IMAGE_PROVIDER_KEY });
  return new MockImageProvider();
}
