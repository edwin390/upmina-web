import { createClient } from "@supabase/supabase-js";
import type { VercelRequest, VercelResponse } from "@vercel/node";
import {
  ACCESS_CHECK_METHOD,
  ACCESS_CHECK_PATH,
  ACCESS_SIGNATURE_HEADER,
  ACCESS_TIMESTAMP_HEADER,
  isAssetUuid,
  verifyAccessRequest,
} from "./media-delivery-protocol.js";

// POST /api/media/access (R4-D1): endpoint EXCLUSIVO del Worker de entrega. No usa sesión de
// usuario: se autentica con una firma HMAC sobre (método, path, timestamp, assetId). Solo responde
// `{ public: boolean }`; nunca estado interno, owner, post, motivo ni claves. Cualquier fallo de
// autenticación es un 401 genérico.

const UNAUTHORIZED = { error: "No autorizado" };
const GENERIC = { error: "No se pudo completar la solicitud" };

function header(req: VercelRequest, name: string): string | undefined {
  const value = req.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

interface DeliveryState {
  exists: boolean;
  domain: "community" | null;
  delivery: "public" | "private" | "denied";
  privateUntil: string | null;
}

function parseDeliveryState(value: unknown): DeliveryState {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid delivery state");
  const v = value as Record<string, unknown>;
  if (typeof v.exists !== "boolean") throw new Error("Invalid delivery state");
  if (v.domain !== null && v.domain !== "community") throw new Error("Invalid domain");
  if (v.delivery !== "public" && v.delivery !== "private" && v.delivery !== "denied")
    throw new Error("Invalid delivery");
  if (v.privateUntil !== null && typeof v.privateUntil !== "string")
    throw new Error("Invalid deadline");
  return v as unknown as DeliveryState;
}

export async function handleMediaAccess(
  req: VercelRequest,
  res: VercelResponse,
): Promise<VercelResponse> {
  res.setHeader("Cache-Control", "private, no-store");
  if (req.method !== ACCESS_CHECK_METHOD) {
    res.setHeader("Allow", ACCESS_CHECK_METHOD);
    return res.status(405).json({ error: "Método no permitido" });
  }
  const secret = process.env.MEDIA_CHECK_SHARED_SECRET?.trim();
  if (!secret) return res.status(500).json(GENERIC);

  const body: unknown = typeof req.body === "string" ? safeParse(req.body) : req.body;
  const assetId =
    body && typeof body === "object" && !Array.isArray(body)
      ? (body as Record<string, unknown>).assetId
      : undefined;
  if (typeof assetId !== "string")
    return res.status(400).json({ error: "Solicitud inválida" });

  const verified = await verifyAccessRequest(secret, {
    method: req.method,
    path: ACCESS_CHECK_PATH,
    timestamp: header(req, ACCESS_TIMESTAMP_HEADER),
    signature: header(req, ACCESS_SIGNATURE_HEADER),
    assetId,
    nowSeconds: Math.floor(Date.now() / 1000),
  });
  if (!verified.ok) return res.status(401).json(UNAUTHORIZED);
  if (!isAssetUuid(assetId)) return res.status(400).json({ error: "Solicitud inválida" });

  const url = process.env.VITE_SUPABASE_URL?.trim();
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (!url || !key) return res.status(500).json(GENERIC);
  try {
    const client = createClient(url, key, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const { data, error } = await client.rpc("community_media_delivery_state", {
      p_asset_id: assetId,
    });
    if (error) return res.status(500).json(GENERIC);
    const state = parseDeliveryState(data);
    return res
      .status(200)
      .json({ public: state.domain === "community" && state.delivery === "public" });
  } catch {
    return res.status(500).json(GENERIC);
  }
}

function safeParse(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}
