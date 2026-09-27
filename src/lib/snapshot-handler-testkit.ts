import { vi } from "vitest";
import type { VercelRequest, VercelResponse } from "@vercel/node";
import { snapshotDb } from "./public-snapshots-supabase-fake";
import type { SnapshotResource } from "./public-snapshot-resources";

// Utilidades SOLO de tests para probar los handlers de Twitch y YouTube con snapshots
// (Fase 9H-4, checkpoint 3): respuesta y petición falsas, respuestas HTTP y siembra de filas.

export function jsonResponse(
  body: unknown,
  status = 200,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

export interface MockState {
  status?: number;
  body?: unknown;
  ended: boolean;
  headers: Record<string, string>;
}

export function mockRes() {
  const state: MockState = { ended: false, headers: {} };
  const res = {
    setHeader(name: string, value: string) {
      state.headers[name] = value;
      return res;
    },
    status(code: number) {
      state.status = code;
      return res;
    },
    json(body: unknown) {
      state.body = body;
      return res;
    },
    end() {
      state.ended = true;
      return res;
    },
  };
  return { res: res as unknown as VercelResponse, state };
}

export const getReq = (query: Record<string, string> = {}) =>
  ({ method: "GET", query }) as unknown as VercelRequest;

export const HOUR = 3_600_000;
export const NOW = Date.UTC(2026, 8, 29, 12, 0, 0);

/** Siembra una fila del snapshot (por defecto capturada hace 1 h respecto de `now`). */
export function seedSnapshot(
  resource: SnapshotResource,
  sourceId: string,
  payload: unknown,
  capturedAtMs: number = Date.now() - HOUR,
) {
  snapshotDb.rows.set(resource, {
    resource,
    source_id: sourceId,
    payload,
    captured_at: new Date(capturedAtMs).toISOString(),
  });
}

/** Cabeceras y cuerpo de una respuesta, en texto: no debe contener source_id ni secretos. */
export function visibleText(state: MockState): string {
  return JSON.stringify({ headers: state.headers, body: state.body });
}

/** Sustituye console.error por un espía silencioso. */
export function silenceErrors() {
  return vi.spyOn(console, "error").mockImplementation(() => {});
}
