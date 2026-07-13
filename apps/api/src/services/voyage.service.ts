// Voyage AI voyage-multimodal-3.5 — text AND image embeddings in one shared space.
// See docs/search.md. 1024-dim, matching the vector(1024) columns on memories/photos.
export async function embedText(_text: string): Promise<number[]> {
  throw new Error("Not implemented");
}

export async function embedImage(_photoR2Key: string): Promise<number[]> {
  throw new Error("Not implemented");
}
