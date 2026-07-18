// Cloudflare R2 client — S3-compatible, using @aws-sdk/client-s3 pointed at
// the R2 endpoint. See docs/media_pipeline.md, "Storage layout (R2)" for the
// key naming convention.
import { S3Client, GetObjectCommand, PutObjectCommand, DeleteObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { env } from "../config/env";

const PRESIGN_EXPIRY_SECONDS = 15 * 60;

let client: S3Client | null = null;

function getClient(): S3Client {
  if (client) return client;
  if (!env.r2.accountId || !env.r2.accessKeyId || !env.r2.secretAccessKey) {
    throw new Error("R2 credentials are not configured — set R2_ACCOUNT_ID/R2_ACCESS_KEY_ID/R2_SECRET_ACCESS_KEY in .env");
  }
  client = new S3Client({
    region: "auto",
    endpoint: `https://${env.r2.accountId}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: env.r2.accessKeyId,
      secretAccessKey: env.r2.secretAccessKey,
    },
  });
  return client;
}

// Presigned PUT — the client uploads bytes directly to R2 with this URL, the
// object never passes through Express (docs/api_structure.md's cross-cutting
// uploads note).
export async function presignUpload(key: string, contentType?: string): Promise<{ url: string; key: string }> {
  const command = new PutObjectCommand({
    Bucket: env.r2.bucket,
    Key: key,
    ContentType: contentType,
  });
  const url = await getSignedUrl(getClient(), command, { expiresIn: PRESIGN_EXPIRY_SECONDS });
  return { url, key };
}

// Download direction, needed by the transcription and voice-cloning workers
// (they need the actual audio bytes, not a presigned URL, since they're
// forwarding them straight into another API's multipart upload).
export async function getObjectBuffer(key: string): Promise<Buffer> {
  const res = await getClient().send(new GetObjectCommand({ Bucket: env.r2.bucket, Key: key }));
  const body = res.Body;
  if (!body) throw new Error(`R2 object ${key} had no body`);
  const chunks: Uint8Array[] = [];
  // @ts-expect-error — Body is a Node.js Readable at runtime in this SDK's Node target.
  for await (const chunk of body) chunks.push(chunk);
  return Buffer.concat(chunks);
}

// Needed by the daily cron sweep's grace-period expiry step (docs/media_pipeline.md
// section 4: "holding_space rows... deleted (DB rows + R2 objects per
// lifecycle rule)"). The sweep calls this best-effort — a missing R2
// integration shouldn't block the DB-side cleanup, which is real, useful
// progress on its own even before storage deletion is wired up.
export async function deleteObject(key: string): Promise<void> {
  await getClient().send(new DeleteObjectCommand({ Bucket: env.r2.bucket, Key: key }));
}
