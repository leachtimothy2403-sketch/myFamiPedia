import { Router } from "express";
import { randomUUID } from "node:crypto";
import { requireAuth, AuthedRequest } from "../middleware/auth";
import { withRlsContext } from "../db/pool";
import { presignUpload } from "../services/r2.service";
import { HttpError } from "../utils/httpError";

export const uploadsRouter = Router();

const EXTENSION_BY_CONTENT_TYPE: Record<string, string> = {
  "audio/m4a": "m4a",
  "audio/mp4": "m4a",
  "audio/mpeg": "mp3",
  "audio/wav": "wav",
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
};

function extensionFor(contentType: string | undefined): string {
  if (!contentType) return "bin";
  return EXTENSION_BY_CONTENT_TYPE[contentType] ?? contentType.split("/")[1]?.split(";")[0] ?? "bin";
}

// Media never passes through Express — this issues a presigned R2 upload
// URL, the client PUTs bytes directly to R2, then calls /complete to
// register the result. Voice/audio uploads (interview answers) don't need
// registration here at all — POST /interview-sessions/:id/answers takes the
// r2Key straight from this response and attaches it itself — so /complete
// for a "voice" context is a harmless no-op; only "photo"/"memory" contexts
// create a row (in `photos`, the one table nothing currently populates).
uploadsRouter.post("/uploads/presign", requireAuth, async (req: AuthedRequest, res, next) => {
  try {
    const { personId, familyGroupId } = req.auth!;
    const { contentType, context } = req.body ?? {};
    if (!context || !["memory", "photo", "voice"].includes(context)) {
      return res.status(400).json({ error: "context must be one of memory, photo, voice" });
    }

    const r2Key = `${context}/${familyGroupId}/${randomUUID()}.${extensionFor(contentType)}`;

    const upload = await withRlsContext({ personId, familyGroupId }, (trx) =>
      trx("uploads")
        .insert({
          family_group_id: familyGroupId,
          uploaded_by: personId,
          r2_key: r2Key,
          context,
          content_type: contentType ?? null,
        })
        .returning("*")
        .then(([row]: { id: string }[]) => row)
    );

    const { url } = await presignUpload(r2Key, contentType);
    res.status(201).json({ uploadId: upload.id, uploadUrl: url, r2Key });
  } catch (err) {
    next(err);
  }
});

uploadsRouter.post("/uploads/:id/complete", requireAuth, async (req: AuthedRequest, res, next) => {
  try {
    const { personId, familyGroupId } = req.auth!;
    const { isPrivate, takenAt } = req.body ?? {};

    const result = await withRlsContext({ personId, familyGroupId }, async (trx) => {
      const upload = await trx("uploads").where({ id: req.params.id, family_group_id: familyGroupId }).first();
      if (!upload) throw new HttpError(404, "Upload not found");
      if (upload.status === "complete") throw new HttpError(409, "This upload has already been completed");

      await trx("uploads").where({ id: upload.id }).update({ status: "complete" });

      if (upload.context === "photo" || upload.context === "memory") {
        const [photo] = await trx("photos")
          .insert({
            family_group_id: familyGroupId,
            r2_key: upload.r2_key,
            uploaded_by: personId,
            is_private: Boolean(isPrivate),
            taken_at: takenAt ?? null,
            source: "manual_upload",
          })
          .returning("*");
        return { photoId: photo.id };
      }
      return { r2Key: upload.r2_key };
    });

    res.status(201).json(result);
  } catch (err) {
    next(err);
  }
});
