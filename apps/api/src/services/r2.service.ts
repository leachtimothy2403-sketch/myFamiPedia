// Cloudflare R2 client — S3-compatible, use @aws-sdk/client-s3 pointed at the R2 endpoint.
// See docs/media_pipeline.md, "Storage layout (R2)" for the key naming convention.
import { env } from "../config/env";

export async function presignUpload(_key: string): Promise<{ url: string; key: string }> {
  throw new Error(`Not implemented — wire up @aws-sdk/client-s3 against R2 account ${env.r2.accountId}`);
}
