import { parseModerationId, parseRawModerationMedia } from "./moderation-case-parser.js";
import type { RawFeedMediaRow } from "./community-feed-domain.js";

/** Server-only batch seam. Storage metadata never comes from the read-model RPC. */
export async function resolveModerationMedia(
  value: unknown,
  lookup: (ids: string[]) => Promise<unknown>,
): Promise<RawFeedMediaRow[]> {
  if (!Array.isArray(value) || value.length > 10) throw new Error("Invalid media");
  const refs = value.map((v: unknown) => {
    if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error("Invalid media");
    const r = v as Record<string, unknown>;
    if (!Number.isSafeInteger(r.position) || (r.position as number) < 0)
      throw new Error("Invalid media position");
    return {
      id: parseModerationId(r.id),
      assetId: parseModerationId(r.assetId),
      position: r.position as number,
    };
  });
  if (!refs.length) return [];
  const data = await lookup([...new Set(refs.map((r) => r.assetId))]);
  if (!Array.isArray(data) || data.length > 10) throw new Error("Media lookup failed");
  const assets = new Map<string, Record<string, unknown>>();
  for (const v of data) {
    if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error("Invalid asset");
    const a = v as Record<string, unknown>;
    const id = parseModerationId(a.id);
    if (a.domain !== "community" || assets.has(id) || !refs.some((r) => r.assetId === id))
      throw new Error("Invalid asset association");
    assets.set(id, a);
  }
  return refs
    .sort((a, b) => a.position - b.position)
    .map((r) => {
      const asset = assets.get(r.assetId);
      if (!asset) throw new Error("Missing media asset");
      return parseRawModerationMedia({
        id: r.id,
        position: r.position,
        media_assets: asset,
      });
    });
}
