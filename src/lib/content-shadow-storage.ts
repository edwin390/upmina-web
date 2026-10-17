// Server-side only. Canonical processed variants are in the DEV delivery bucket;
// reading that bucket through S3 does not create a public URL or bypass the delivery Worker.
import type { SupabaseClient } from "@supabase/supabase-js";
import { GetObjectCommand } from "@aws-sdk/client-s3";
import sharp from "sharp";
import { getR2DevConfig } from "./r2-client.js";
import { publicVariantKey } from "./media-domain.js";
import type { ShadowJob } from "./content-shadow-contract.js";
import type { ShadowMediaReader, ShadowRepository } from "./content-shadow-executor.js";
import { ShadowFault } from "./content-shadow-provider.js";
export const SHADOW_IMAGE_BYTES = 4 * 1024 * 1024; // Internal budget, not a provider-limit claim.
interface Variant {
  variant: number;
  bytes: number;
  storage_key: string;
}
interface ObjectBody {
  contentType: string | undefined;
  contentLength: number | undefined;
  stream: AsyncIterable<Uint8Array> & { destroy?: () => void };
}
export type ShadowObjectRead = (key: string, signal: AbortSignal) => Promise<ObjectBody>;

export function shadowRepository(client: SupabaseClient): ShadowRepository {
  return {
    async claim(signal) {
      const { data, error } = await client
        .rpc("community_shadow_claim", { p_limit: 1, p_lease_seconds: 120 })
        .abortSignal(signal);
      if (error) throw new ShadowFault("internal_failure");
      return data;
    },
    async finish(input, signal) {
      const { data, error } = await client
        .rpc("community_shadow_finish", { ...input })
        .abortSignal(signal);
      if (error) throw new ShadowFault("internal_failure");
      return data;
    },
  };
}
const normalized = (t: string | null): string | null =>
  t === null ? null : t.replace(/^ +| +$/g, "").normalize("NFC") || null;
export async function verifyShadowTarget(
  client: SupabaseClient,
  job: ShadowJob,
  signal: AbortSignal,
): Promise<void> {
  const { data: p, error } = await client
    .from("community_posts")
    .select("id,author_user_id,version,status,text")
    .eq("id", job.post_id)
    .abortSignal(signal)
    .maybeSingle();
  if (error) throw new ShadowFault("asset_unavailable", true);
  if (
    !p ||
    p.author_user_id !== job.author_user_id ||
    p.version !== job.version ||
    !["published", "held_for_review"].includes(p.status)
  )
    throw new ShadowFault("asset_unavailable");
  let text = p.text;
  if (job.target_kind === "pending_edit") {
    const { data: e, error: ee } = await client
      .from("community_post_pending_edits")
      .select("id,post_id,base_version,status,text")
      .eq("id", job.edit_id)
      .abortSignal(signal)
      .maybeSingle();
    if (ee) throw new ShadowFault("asset_unavailable", true);
    if (
      !e ||
      e.post_id !== job.post_id ||
      e.status !== "pending" ||
      p.status !== "published" ||
      e.base_version !== job.base_version
    )
      throw new ShadowFault("asset_unavailable");
    text = e.text;
  }
  if (
    (typeof text !== "string" && text !== null) ||
    normalized(text) !== job.snapshot_text
  )
    throw new ShadowFault("asset_unavailable");
  const { data: refs, error: me } = await client
    .from(
      job.target_kind === "post"
        ? "community_post_media"
        : "community_post_pending_edit_media",
    )
    .select("asset_id,position")
    .eq(job.target_kind === "post" ? "post_id" : "edit_id", job.edit_id ?? job.post_id)
    .order("position")
    .limit(11)
    .abortSignal(signal);
  if (me) throw new ShadowFault("asset_unavailable", true);
  if (
    !Array.isArray(refs) ||
    refs.length !== job.assets.length ||
    refs.some(
      (r, i) =>
        r.asset_id !== job.assets[i].asset_id || r.position !== job.assets[i].position,
    )
  )
    throw new ShadowFault("asset_unavailable");
}

/** Only a canonical key chosen below reaches this implementation; never a browser input. */
async function readDevObject(key: string, signal: AbortSignal): Promise<ObjectBody> {
  const { client, publicBucket } = getR2DevConfig();
  if (
    publicBucket !== "upmina-media-dev-public" ||
    process.env.VERCEL_ENV === "production"
  )
    throw new ShadowFault("asset_unavailable");
  const out = await client.send(
    new GetObjectCommand({
      Bucket: publicBucket,
      Key: key,
      Range: `bytes=0-${SHADOW_IMAGE_BYTES}`,
    }),
    { abortSignal: signal },
  );
  if (!out.Body) throw new ShadowFault("asset_unavailable");
  return {
    contentType: out.ContentType,
    contentLength: out.ContentLength,
    stream: out.Body as ObjectBody["stream"],
  };
}

export function shadowMediaReader(
  client: SupabaseClient,
  readObject: ShadowObjectRead = readDevObject,
): ShadowMediaReader {
  return {
    verify: (job, signal) => verifyShadowTarget(client, job, signal),
    async read(job, assetId, signal) {
      if (!job.assets.some((a) => a.asset_id === assetId && a.kind === "image"))
        throw new ShadowFault("asset_unavailable");
      await verifyShadowTarget(client, job, signal);
      const { data: a, error } = await client
        .from("media_assets")
        .select("id,domain,created_by,status,kind,mime")
        .eq("id", assetId)
        .abortSignal(signal)
        .maybeSingle();
      if (error) throw new ShadowFault("asset_unavailable", true);
      if (
        !a ||
        a.id !== assetId ||
        a.domain !== "community" ||
        a.created_by !== job.author_user_id ||
        a.status !== "ready" ||
        a.kind !== "image" ||
        a.mime !== "image/webp"
      )
        throw new ShadowFault("asset_unavailable");
      const { data, error: ve } = await client
        .from("media_asset_variants")
        .select("variant,bytes,storage_key")
        .eq("asset_id", assetId)
        .in("variant", [480, 960, 1600])
        .order("variant", { ascending: false })
        .limit(3)
        .abortSignal(signal);
      if (ve) throw new ShadowFault("asset_unavailable", true);
      const variants = [...((data ?? []) as Variant[])].sort(
        (a, b) => b.variant - a.variant,
      );
      const v = variants.find(
        (v) =>
          [480, 960, 1600].includes(v.variant) &&
          Number.isSafeInteger(v.bytes) &&
          v.bytes > 0 &&
          v.bytes <= SHADOW_IMAGE_BYTES &&
          v.storage_key === publicVariantKey("community", assetId, v.variant),
      );
      if (!v) throw new ShadowFault("asset_unavailable");
      let body: ObjectBody | undefined;
      let bytes: Buffer | undefined;
      const destroy = () => body?.stream.destroy?.();
      try {
        body = await readObject(v.storage_key, signal);
        signal.addEventListener("abort", destroy, { once: true });
        if (
          signal.aborted ||
          body.contentType !== "image/webp" ||
          body.contentLength !== v.bytes ||
          body.contentLength > SHADOW_IMAGE_BYTES
        )
          throw new ShadowFault("asset_unavailable");
        // A byte cap alone does not bound the number of retained chunk objects.
        // One allocation and a fragment cap also bound empty/tiny-chunk amplification.
        bytes = Buffer.alloc(v.bytes);
        let size = 0,
          fragments = 0;
        for await (const chunk of body.stream) {
          if (
            signal.aborted ||
            ++fragments > 65536 ||
            !(chunk instanceof Uint8Array) ||
            size + chunk.byteLength > SHADOW_IMAGE_BYTES ||
            size + chunk.byteLength > v.bytes
          )
            throw new ShadowFault("asset_unavailable");
          bytes.set(chunk, size);
          size += chunk.byteLength;
        }
        if (size !== v.bytes) throw new ShadowFault("asset_unavailable");
        if (
          bytes.toString("ascii", 0, 4) !== "RIFF" ||
          bytes.toString("ascii", 8, 12) !== "WEBP"
        )
          throw new ShadowFault("asset_unavailable");
        const meta = await sharp(bytes, { limitInputPixels: 1600 * 1600 }).metadata();
        if (
          signal.aborted ||
          meta.format !== "webp" ||
          !meta.width ||
          !meta.height ||
          Math.max(meta.width, meta.height) > v.variant ||
          (meta.pages ?? 1) > 1
        )
          throw new ShadowFault("asset_unavailable");
        const result = bytes;
        bytes = undefined;
        return result;
      } catch (e) {
        throw e instanceof ShadowFault ? e : new ShadowFault("asset_unavailable", true);
      } finally {
        signal.removeEventListener("abort", destroy);
        destroy();
        bytes?.fill(0);
      }
    },
  };
}
