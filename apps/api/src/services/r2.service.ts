// Cloudflare R2 client — S3-compatible, use @aws-sdk/client-s3 pointed at the R2 endpoint.
// See docs/media_pipeline.md, "Storage layout (R2)" for the key naming convention.
import { env } from "../config/env";

export async function presignUpload(_key: string): Promise<{ url: string; key: string }> {
  throw new Error(`Not implemented — wire up @aws-sdk/client-s3 against R2 account ${env.r2.accountId}`);
}

// Download direction, needed by the transcription and voice-cloning workers
// (they need the actual audio bytes, not a presigned URL, since they're
// forwarding them straight into another API's multipart upload). Same
// not-yet-wired boundary as presignUpload above — every worker that calls
// this is fully implemented and tested against a fake that returns canned
// bytes; only this one function is the real stub.
export async function getObjectBuffer(_key: string): Promise<Buffer> {
  throw new Error(`Not implemented — wire up @aws-sdk/client-s3 against R2 account ${env.r2.accountId}`);
}
