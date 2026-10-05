import { createClient } from "@supabase/supabase-js";
import type { VercelRequest, VercelResponse } from "@vercel/node";
import { AdminAuthError, requireAuthenticated } from "./admin-auth.js";
import {
  authorRecord,
  parseAuthorAck,
  parseAuthorPost,
  parseAuthorPostsResponse,
} from "./community-author-contract.js";
import { parseModerationId, parseRawModerationMedia } from "./moderation-case-parser.js";
import {
  communityMediaUrlForViewer,
  loadMediaUrlContext,
  publicMediaUrl,
} from "./media-delivery-url.js";

const generic = { error: "No se pudo completar la solicitud", code: "internal_failure" };
export async function handleCommunityAuthorPosts(
  req: VercelRequest,
  res: VercelResponse,
): Promise<VercelResponse> {
  return handle(req, res, false);
}
export async function handleCommunityAuthorNoticeAck(
  req: VercelRequest,
  res: VercelResponse,
): Promise<VercelResponse> {
  return handle(req, res, true);
}
async function handle(
  req: VercelRequest,
  res: VercelResponse,
  ack: boolean,
): Promise<VercelResponse> {
  res.setHeader("Cache-Control", "private, no-store");
  if (req.method !== (ack ? "POST" : "GET")) {
    res.setHeader("Allow", ack ? "POST" : "GET");
    return res.status(405).json({ error: "Método no permitido" });
  }
  let actor: string;
  try {
    actor = (await requireAuthenticated(req)).userId;
  } catch (e) {
    return e instanceof AdminAuthError
      ? res.status(e.status).json({ error: e.message })
      : res.status(500).json(generic);
  }
  let postId: string | null = null,
    noticeId: string | null = null;
  const entry = req.query.profileEntry === "true";
  try {
    if (ack) {
      const body = authorRecord(
        typeof req.body === "string" ? JSON.parse(req.body) : req.body,
      );
      postId = parseModerationId(body.postId);
      noticeId = parseModerationId(body.noticeId);
    } else if (req.query.postId !== undefined)
      postId = parseModerationId(req.query.postId);
    if (
      req.query.profileEntry !== undefined &&
      !["true", "false"].includes(String(req.query.profileEntry))
    )
      throw new Error("Invalid context");
  } catch {
    return res.status(400).json({ error: "Solicitud inválida", code: "validation" });
  }
  const url = process.env.VITE_SUPABASE_URL?.trim(),
    key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (!url || !key) return res.status(500).json(generic);
  const client = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const started = performance.now();
  try {
    const { data, error } = await client.rpc(
      ack ? "community_author_notice_ack" : "community_author_posts_read",
      ack
        ? { p_actor_user_id: actor, p_post_id: postId, p_notice_id: noticeId }
        : { p_actor_user_id: actor, p_post_id: postId, p_profile_entry: entry },
    );
    if (error) {
      if (error.message === "not_found")
        return res.status(404).json({ error: "No encontrado", code: "not_found" });
      return res.status(500).json(generic);
    }
    if (ack) return res.status(200).json(parseAuthorAck(data));
    const raw = authorRecord(data);
    if (!Array.isArray(raw.items)) throw new Error("Invalid DB result");
    // Validate the base projection before using its references. One batch SELECT for the entire list.
    const refs = new Map<string, { id: string; assetId: string; position: number }[]>();
    const posts = raw.items.map((v: unknown) => {
      const p = authorRecord(v),
        base = parseAuthorPost({ ...p, media: [] });
      if (!Array.isArray(p.media) || p.media.length > 10)
        throw new Error("Invalid media");
      refs.set(
        base.id,
        p.media.map((v: unknown) => {
          const m = authorRecord(v);
          if (
            typeof m.position !== "number" ||
            !Number.isInteger(m.position) ||
            m.position < 0 ||
            m.position > 9
          )
            throw new Error("Invalid position");
          return {
            id: parseModerationId(m.id),
            assetId: parseModerationId(m.assetId),
            position: m.position,
          };
        }),
      );
      return base;
    });
    const ids = [...new Set([...refs.values()].flat().map((m) => m.assetId))];
    const assets = new Map<string, Record<string, unknown>>();
    if (ids.length) {
      const lookup = await client
        .from("media_assets")
        .select("id, domain, status, kind, storage_key, width, height, duration_seconds")
        .in("id", ids);
      if (lookup.error || !Array.isArray(lookup.data)) throw new Error("Lookup failed");
      for (const v of lookup.data) {
        const a = authorRecord(v),
          id = parseModerationId(a.id);
        if (a.domain !== "community" || assets.has(id) || !ids.includes(id))
          throw new Error("Invalid asset");
        assets.set(id, a);
      }
    }
    // DB time is authoritative. Deduct the full request processing duration conservatively so
    // media lookup latency cannot serve a retained post that expired during this read. The same
    // server-derived instant bounds every private media capability (never the client clock).
    const serverBound = Date.parse(String(raw.serverNow)) + (performance.now() - started);
    const mediaContext = await loadMediaUrlContext();
    const items = await Promise.all(
      posts.map(async (p) => {
        const purgeAfterMs = p.moderation.deadline
          ? Date.parse(p.moderation.deadline)
          : null;
        return {
          ...p,
          media: await Promise.all(
            refs.get(p.id)!.map(async (m) => {
              const a = assets.get(m.assetId);
              if (!a) throw new Error("Missing asset");
              const validated = parseRawModerationMedia({
                id: m.id,
                position: m.position,
                media_assets: a,
              }).media_assets!;
              let url: string | null = null;
              if (validated.status === "ready" && validated.storage_key) {
                // Manual `hidden` keeps its legacy URL only while secure delivery is not configured.
                url =
                  p.status === "hidden" && !mediaContext.base
                    ? publicMediaUrl(validated.storage_key)
                    : await communityMediaUrlForViewer(mediaContext, {
                        scope: "owner",
                        status: p.status,
                        purgeAfterMs,
                        nowMs: serverBound,
                        storageKey: validated.storage_key,
                        assetId: m.assetId,
                      });
              }
              return {
                id: m.id,
                assetId: m.assetId,
                position: m.position,
                assetStatus: validated.status,
                kind: validated.kind,
                width: validated.width,
                height: validated.height,
                durationSeconds:
                  validated.kind === "video" ? validated.duration_seconds : null,
                url,
              };
            }),
          ),
        };
      }),
    );
    const normalized = parseAuthorPostsResponse({
      items,
      serverNow: raw.serverNow,
      noticeId: raw.noticeId,
    });
    normalized.items = normalized.items.filter(
      (p) => !p.moderation.deadline || Date.parse(p.moderation.deadline) > serverBound,
    );
    normalized.serverNow = new Date(serverBound).toISOString();
    if (
      postId &&
      (normalized.items.length > 1 ||
        normalized.items.some((p) => p.id !== postId || p.status === "hidden"))
    )
      throw new Error("Invalid requested context");
    if (!postId && normalized.noticeId !== null) throw new Error("Invalid list notice");
    if (!entry && normalized.noticeId !== null) throw new Error("Invalid entry notice");
    if (postId && !normalized.items.length)
      return res.status(404).json({ error: "No encontrado", code: "not_found" });
    return res.status(200).json(normalized);
  } catch {
    return res.status(500).json(generic);
  }
}
