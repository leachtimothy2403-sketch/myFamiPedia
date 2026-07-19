// HEIC/HEIF -> JPEG conversion for image bytes headed to a vision API.
// AWS Rekognition (DetectFaces/DetectLabels) and Claude's Messages API only
// accept JPEG/PNG (claude.service.ts even hardcodes `media_type: "image/jpeg"`
// on every call already, so it was silently relying on this being true) —
// but iPhones default to capturing photos as HEIC, and nothing in the
// upload path (uploads.routes.ts, collection.routes.ts's camera-roll sync)
// converts format before the bytes reach R2. A HEIC photo therefore failed
// both Rekognition calls outright (InvalidImageFormatException) and would
// have silently mismatched Claude's hardcoded media_type had it ever gotten
// that far.
//
// Deliberately NOT using sharp for this: sharp's npm-published prebuilt
// binaries exclude libheif/libde265/x265 entirely, because of HEVC patent
// licensing (github.com/lovell/sharp#4479) — HEIC decoding only works with a
// from-source libvips build, which most environments (including local dev
// on Windows, and most standard Node hosting) don't have and won't get from
// a plain install. heic-convert wraps libheif-js, a WebAssembly build with
// no native compilation step, so `pnpm install` alone is enough wherever
// this runs.
import convert from "heic-convert";

const HEIC_EXTENSIONS = new Set(["heic", "heif"]);

function extensionOf(r2Key: string): string {
  return r2Key.split(".").pop()?.toLowerCase() ?? "";
}

/**
 * Returns JPEG bytes for HEIC/HEIF input; returns the input unchanged for
 * anything else (already-JPEG/PNG photos are the common case and shouldn't
 * pay a conversion cost). Only call sites that hand bytes to Rekognition or
 * Claude need this — not r2.service.ts's getObjectBuffer itself, which is
 * also used for non-image (audio) reads that must never be run through an
 * image decoder.
 */
export async function ensureVisionCompatible(bytes: Buffer, r2Key: string): Promise<Buffer> {
  if (!HEIC_EXTENSIONS.has(extensionOf(r2Key))) return bytes;
  const converted = await convert({ buffer: bytes, format: "JPEG", quality: 0.92 });
  return Buffer.from(converted);
}
