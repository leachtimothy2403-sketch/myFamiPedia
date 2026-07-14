// Voyage AI embeddings — plain REST (Bearer auth), used for the semantic-mode
// half of search.routes.ts and the Q_EMBED worker (docs/search.md). Real
// implementation, gated on VOYAGE_API_KEY, same pattern as transcription/voiceClone.
//
// docs/search.md is explicit that this MUST be voyage-multimodal-3.5, not a
// text-only model: text and image embeddings need to land in the same
// 1024-dim space so memories.embedding and photos.embedding can be compared
// and ranked together in one union query. embedText/embedImage both call the
// same multimodalembeddings endpoint with different content-block types —
// see https://docs.voyageai.com/reference/multimodal-embeddings-api for the
// request shape.
import { env } from "../config/env";

export interface EmbeddingService {
  /** Text-mode: memories.content (+ transcript for voice memories), and the search query itself. */
  embedText(texts: string[]): Promise<number[][]>;
  /** Image-mode: a photo's raw bytes, embedded directly — no captioning step. */
  embedImage(images: { bytes: Buffer; mimeType: string }[]): Promise<number[][]>;
}

const MODEL = "voyage-multimodal-3.5";

class VoyageEmbeddingService implements EmbeddingService {
  private async multimodalEmbed(inputs: unknown[]): Promise<number[][]> {
    if (!env.voyageApiKey) {
      throw new Error("EmbeddingService is not configured — set VOYAGE_API_KEY. See docs/search.md.");
    }
    const res = await fetch("https://api.voyageai.com/v1/multimodalembeddings", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.voyageApiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ inputs, model: MODEL, output_dimension: 1024 }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`Voyage multimodal embeddings request failed (${res.status}): ${body}`);
    }
    const data = (await res.json()) as { data: { embedding: number[] }[] };
    return data.data.map((d) => d.embedding);
  }

  embedText(texts: string[]): Promise<number[][]> {
    return this.multimodalEmbed(texts.map((text) => ({ content: [{ type: "text", text }] })));
  }

  embedImage(images: { bytes: Buffer; mimeType: string }[]): Promise<number[][]> {
    return this.multimodalEmbed(
      images.map((img) => ({
        content: [{ type: "image_base64", image_base64: `data:${img.mimeType};base64,${img.bytes.toString("base64")}` }],
      }))
    );
  }
}

export const embeddingService: EmbeddingService = new VoyageEmbeddingService();
