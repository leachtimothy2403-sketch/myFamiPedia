import { describe, it, expect, vi } from "vitest";

// heic-convert wraps libheif-js (WASM) — mocked here rather than decoding a
// real HEIC fixture, since the thing worth locking down is the wiring
// (which r2_key extensions trigger conversion, what gets passed to the
// library, what comes back), not libheif-js's own decode correctness. The
// real decode path was verified manually end-to-end tonight: a genuine HEIC
// photo from an iPhone, uploaded through the app, correctly produced
// detected faces via Rekognition once this fix + `pnpm install` landed —
// see collection/add-photo.tsx's flow. That's the case this whole file
// exists to prevent regressing.
const convertMock = vi.fn(async () => new Uint8Array([1, 2, 3]));
vi.mock("heic-convert", () => ({ default: (...args: unknown[]) => convertMock(...args) }));

describe("ensureVisionCompatible", () => {
  it("returns bytes unchanged for a non-HEIC extension, without invoking the converter", async () => {
    const { ensureVisionCompatible } = await import("../../src/services/imageNormalization.service");
    const original = Buffer.from("not actually image data, doesn't matter here");
    const result = await ensureVisionCompatible(original, "photo/family/abc123.jpg");
    expect(result).toBe(original);
    expect(convertMock).not.toHaveBeenCalled();
  });

  it("converts .heic input to JPEG via heic-convert", async () => {
    convertMock.mockClear();
    const { ensureVisionCompatible } = await import("../../src/services/imageNormalization.service");
    const original = Buffer.from("fake heic bytes");
    const result = await ensureVisionCompatible(original, "photo/family/abc123.heic");

    expect(convertMock).toHaveBeenCalledTimes(1);
    expect(convertMock).toHaveBeenCalledWith(
      expect.objectContaining({ buffer: original, format: "JPEG" })
    );
    expect(Buffer.isBuffer(result)).toBe(true);
    expect(Array.from(result)).toEqual([1, 2, 3]);
  });

  it("treats .HEIF (any case) as HEIC too", async () => {
    convertMock.mockClear();
    const { ensureVisionCompatible } = await import("../../src/services/imageNormalization.service");
    await ensureVisionCompatible(Buffer.from("x"), "photo/family/abc123.HEIF");
    expect(convertMock).toHaveBeenCalledTimes(1);
  });

  it("does not misfire on a key that merely contains 'heic' mid-string with a normal extension", async () => {
    convertMock.mockClear();
    const { ensureVisionCompatible } = await import("../../src/services/imageNormalization.service");
    const original = Buffer.from("x");
    const result = await ensureVisionCompatible(original, "photo/family/theheic-photo.jpg");
    expect(result).toBe(original);
    expect(convertMock).not.toHaveBeenCalled();
  });
});
