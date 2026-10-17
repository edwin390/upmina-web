import type { VercelRequest, VercelResponse } from "@vercel/node";
import { createClient } from "@supabase/supabase-js";
import { AdminAuthError, authErrorBody, requireCapability } from "./admin-auth.js";
import { runShadowBatch, type ShadowSummary } from "./content-shadow-executor.js";
import { FakeModerationTransport } from "./content-shadow-provider.js";
import { shadowMediaReader, shadowRepository } from "./content-shadow-storage.js";

// One in-flight HTTP batch per module instance. This is NOT a distributed/global lock.
let shadowRunActive = false;

function isDevRuntime(): boolean {
  const url = process.env.VITE_SUPABASE_URL?.trim();
  return (
    url === "https://rkqeqbqwdswhpzwqptac.supabase.co" &&
    process.env.VERCEL_ENV !== "production" &&
    (!process.env.VERCEL_PROJECT_ID ||
      process.env.VERCEL_PROJECT_ID === "prj_fz4fs3FBfz2Gn4LH1Qnew18PpBrP")
  );
}
async function runDefault(limit: number): Promise<ShadowSummary> {
  if (!isDevRuntime()) throw new Error("configuration");
  const url = process.env.VITE_SUPABASE_URL!.trim();
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (!key) throw new Error("configuration");
  const client = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return runShadowBatch(
    {
      repository: shadowRepository(client),
      media: shadowMediaReader(client),
      transport: new FakeModerationTransport(),
    },
    limit,
  );
}
export function createShadowRunHandler(run = runDefault) {
  return async (req: VercelRequest, res: VercelResponse) => {
    res.setHeader("Cache-Control", "private, no-store");
    if (req.method !== "POST") {
      res.setHeader("Allow", "POST");
      return res.status(405).json({ error: "Método no permitido" });
    }
    // Check public environment identity BEFORE the shared JWT guard could contact Auth.
    if (run === runDefault && !isDevRuntime())
      return res.status(503).json({ error: "Servicio no disponible" });
    try {
      await requireCapability(req, "developer_panel");
    } catch (e) {
      return e instanceof AdminAuthError
        ? res.status(e.status).json(authErrorBody(e))
        : res.status(503).json({ error: "Servicio no disponible" });
    }
    if (process.env.CONTENT_SHADOW_RUN_ENABLED !== "true")
      return res.status(503).json({ error: "Ejecución deshabilitada" });
    let body: unknown = req.body;
    try {
      if (typeof body === "string") {
        if (body.length > 128) throw new Error();
        body = JSON.parse(body);
      }
      if (
        !body ||
        typeof body !== "object" ||
        Array.isArray(body) ||
        Object.keys(body).some((k) => k !== "limit") ||
        Object.keys(req.query).some((k) => k !== "action")
      )
        throw new Error();
      const rawLimit = (body as { limit?: unknown }).limit;
      const limit = rawLimit === undefined ? 1 : rawLimit;
      if (!Number.isInteger(limit) || (limit as number) < 1 || (limit as number) > 2)
        throw new Error();
    } catch {
      return res.status(400).json({ error: "Solicitud inválida" });
    }
    if (shadowRunActive) return res.status(409).json({ error: "Ejecución en curso" });
    shadowRunActive = true;
    try {
      const summary = await run((body as { limit?: number }).limit ?? 1);
      // Closed projection: no job IDs, tokens, scores, assets or provider payloads.
      return res.status(summary.persistenceErrors ? 503 : 200).json({
        mode: "simulated",
        claimed: summary.claimed,
        attemptedEvaluations: summary.attemptedEvaluations,
        finished: summary.finished,
        completed: summary.completed,
        partial: summary.partial,
        failed: summary.failed,
        retryWait: summary.retryWait,
        rejected: summary.rejected,
        persistenceErrors: summary.persistenceErrors,
      });
    } catch {
      return res.status(503).json({ error: "Servicio no disponible" });
    } finally {
      shadowRunActive = false;
    }
  };
}
export const handleContentShadowRun = createShadowRunHandler();
