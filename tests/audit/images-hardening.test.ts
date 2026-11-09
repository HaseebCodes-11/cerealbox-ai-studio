import { describe, expect, it } from "vitest";
import { HttpImageProvider, validateImagePayload } from "../../src/areas/static/images";
import type { BrandPalette } from "../../src/core/brief";

const png1x1 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
const palette: BrandPalette = { primary: "#111111", secondary: "#222222", accent: "#f2b134", background: "#ffffff", text: "#000000", fontFamily: "Inter" };
const request = { prompt: "warm kitchen", width: 100, height: 100, palette };

function provider(body: unknown, init: { status?: number; delayMs?: number } = {}, options: Partial<ConstructorParameters<typeof HttpImageProvider>[0]> = {}) {
  const fetchImpl: typeof fetch = async (_url, reqInit) =>
    new Promise((resolve, reject) => {
      const t = setTimeout(() => resolve(new Response(JSON.stringify(body), { status: init.status ?? 200 })), init.delayMs ?? 0);
      reqInit?.signal?.addEventListener("abort", () => {
        clearTimeout(t);
        reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
      });
    });
  return new HttpImageProvider({ endpoint: "https://images.test/generate", fetchImpl, ...options });
}

describe("HttpImageProvider hardening (SEC-04)", () => {
  it("still embeds a valid PNG response exactly as before", async () => {
    const img = await provider({ imageBase64: png1x1, mimeType: "image/png" }).generate(request);
    expect(img.dataUri).toBe(`data:image/png;base64,${png1x1}`);
    expect(img.markup).toContain(`href="data:image/png;base64,${png1x1}"`);
    expect(img.markup).toContain('width="100" height="100"');
  });

  it("defaults a missing mimeType to image/png", async () => {
    const img = await provider({ imageBase64: png1x1 }).generate(request);
    expect(img.dataUri?.startsWith("data:image/png;base64,")).toBe(true);
  });

  it("refuses a MIME type that could inject attributes or script into the SVG", async () => {
    for (const mimeType of ['image/svg+xml" onload="alert(1)', "text/html", "image/svg+xml", "application/octet-stream"]) {
      await expect(provider({ imageBase64: png1x1, mimeType }).generate(request), mimeType).rejects.toThrow(/unsupported type/);
    }
  });

  it("refuses malformed base64 and empty payloads", async () => {
    await expect(provider({ imageBase64: 'abc"><script>', mimeType: "image/png" }).generate(request)).rejects.toThrow(/malformed base64/);
    await expect(provider({ imageBase64: "", mimeType: "image/png" }).generate(request)).rejects.toThrow(/no image/);
    await expect(provider({ mimeType: "image/png" }).generate(request)).rejects.toThrow(/no image/);
  });

  it("caps the decoded size", async () => {
    const big = "A".repeat(4 * 1024); // 3 KB decoded
    await expect(provider({ imageBase64: big, mimeType: "image/jpeg" }, {}, { maxBytes: 2048 }).generate(request)).rejects.toThrow(/above the 2048 byte limit/);
    await expect(provider({ imageBase64: big, mimeType: "image/jpeg" }, {}, { maxBytes: 4096 }).generate(request)).resolves.toBeTruthy();
  });

  it("times out instead of hanging the pipeline", async () => {
    await expect(provider({ imageBase64: png1x1 }, { delayMs: 200 }, { timeoutMs: 20 }).generate(request)).rejects.toThrow(/timed out after 20 ms/);
  });

  it("surfaces HTTP failures as before", async () => {
    await expect(provider({ error: "quota" }, { status: 429 }).generate(request)).rejects.toThrow(/returned 429/);
  });

  it("validateImagePayload computes decoded size from padding", () => {
    expect(validateImagePayload({ imageBase64: "QUJD" }, "p").dataUri).toBe("data:image/png;base64,QUJD"); // "ABC" = 3 bytes
    expect(() => validateImagePayload({ imageBase64: "QUJD" }, "p", 2)).toThrow(/returned 3 bytes/);
    expect(() => validateImagePayload({ imageBase64: "QUI=" }, "p", 2)).not.toThrow(); // "AB" = 2 bytes
  });
});
