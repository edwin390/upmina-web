// @vitest-environment node
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  runCompletionNotices,
  runDeletionJob,
  type DeletionDb,
  type WorkerDeps,
} from "./account-deletion-worker";
import type { MailMessage, SendResult } from "./mfa-recovery-mail";

const REQ = "11111111-1111-4111-8111-111111111111";
const USER = "22222222-2222-4222-8222-222222222222";

function fake(opts: {
  claim?: unknown;
  send?: (m: MailMessage) => SendResult | Promise<SendResult>;
  noSender?: boolean;
  captureThrows?: boolean;
}) {
  const log: Array<{ fn: string; args: Record<string, unknown> }> = [];
  const sent: MailMessage[] = [];
  const db: DeletionDb = {
    rpc: async (fn, args = {}) => {
      log.push({ fn, args });
      if (fn === "account_deletion_notice_capture" && opts.captureThrows)
        throw new Error("boom");
      if (fn === "account_deletion_notice_claim")
        return { data: opts.claim ?? [], error: null };
      if (fn === "account_deletion_step_start")
        return { data: { alreadyDone: false }, error: null };
      if (fn === "account_deletion_step_finish")
        return { data: { completed: args.p_stage === "auth_delete" }, error: null };
      if (fn === "account_deletion_stage_media")
        return { data: { pending: 0 }, error: null };
      return { data: {}, error: null };
    },
  };
  const deps: WorkerDeps = {
    db,
    authAdmin: {
      banUser: async () => ({ outcome: "ok" }),
      deleteUser: async () => ({ outcome: "ok" }),
    },
    workerId: "w-test",
    ...(opts.noSender
      ? {}
      : {
          notices: {
            sender: {
              send: async (m) => {
                sent.push(m);
                return opts.send ? opts.send(m) : { ok: true };
              },
            },
          },
        }),
  };
  return { deps, log, sent };
}
const rows = (locale = "es") => [
  { requestId: REQ, recipient: "person@example.invalid", locale, attempt: 1 },
];
const finishArgs = (log: Array<{ fn: string; args: Record<string, unknown> }>) =>
  log.filter((l) => l.fn === "account_deletion_notice_finish").map((l) => l.args);

describe("DEL-4: ejecutor de avisos finales (dobles, sin correo real)", () => {
  it("envío exitoso: usa el constructor, la clave de idempotencia fija y registra éxito", async () => {
    const { deps, log, sent } = fake({ claim: rows("de") });
    expect(await runCompletionNotices(deps)).toEqual({ sent: 1, failed: 0 });
    expect(sent).toHaveLength(1);
    expect(sent[0]!.idempotencyKey).toBe(`account-deletion-completed-${REQ}`);
    expect(sent[0]!.text).toContain("Wir haben");
    expect(sent[0]!.html).not.toMatch(/https?:\/\//);
    expect(finishArgs(log)).toEqual([
      { p_request_id: REQ, p_worker: "w-test", p_ok: true, p_error_code: null },
    ]);
    expect(log[0]!.fn).toBe("account_deletion_notice_purge"); // la purga va primero
  });

  it("fallo del proveedor: registra un código cerrado y no lanza", async () => {
    const { deps, log } = fake({
      claim: rows(),
      send: () => ({ ok: false, errorClass: "provider_unavailable" }),
    });
    expect(await runCompletionNotices(deps)).toEqual({ sent: 0, failed: 1 });
    expect(finishArgs(log)[0]).toMatchObject({
      p_ok: false,
      p_error_code: "provider_unavailable",
    });
  });

  it("el remitente lanza o devuelve una clase desconocida: código unexpected", async () => {
    const a = fake({
      claim: rows(),
      send: () => {
        throw new Error("x");
      },
    });
    await runCompletionNotices(a.deps);
    expect(finishArgs(a.log)[0]).toMatchObject({
      p_ok: false,
      p_error_code: "unexpected",
    });
    const b = fake({
      claim: rows(),
      send: () => ({ ok: false, errorClass: "weird" as never }),
    });
    await runCompletionNotices(b.deps);
    expect(finishArgs(b.log)[0]).toMatchObject({ p_error_code: "unexpected" });
  });

  it("sin credenciales de correo: no envía y registra not_configured", async () => {
    const { deps, log, sent } = fake({ claim: rows(), noSender: true });
    expect(await runCompletionNotices(deps)).toEqual({ sent: 0, failed: 1 });
    expect(sent).toEqual([]);
    expect(finishArgs(log)[0]).toMatchObject({ p_error_code: "not_configured" });
  });

  it("filas malformadas se ignoran; un idioma desconocido usa inglés", async () => {
    const { deps, sent } = fake({
      claim: [
        { requestId: 5 },
        { requestId: REQ, recipient: "a@b.invalid", locale: "xx" },
      ],
    });
    await runCompletionNotices(deps);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.text).toContain("We have finished");
  });

  it("si la BD falla al reclamar, no envía nada", async () => {
    const { deps, sent } = fake({});
    deps.db = { rpc: async () => ({ data: null, error: { message: "x" } }) };
    expect(await runCompletionNotices(deps)).toEqual({ sent: 0, failed: 0 });
    expect(sent).toEqual([]);
  });

  it("la captura va antes de las etapas y su fallo NO altera la limpieza", async () => {
    const { deps, log } = fake({ captureThrows: true });
    const summary = await runDeletionJob(deps, { requestId: REQ, userId: USER });
    expect(summary).toMatchObject({ completed: true, stagesDone: 6 });
    expect(log[0]!.fn).toBe("account_deletion_notice_capture");
    expect(log.some((l) => l.fn === "account_deletion_notice_claim")).toBe(false); // el aviso se envía aparte, tras el lote
  });
});

describe("DEL-4: migración (comprobaciones estructurales; el comportamiento SQL requiere PGlite)", () => {
  const sql = readFileSync(
    resolve("supabase/migrations/20261127120000_account_deletion_completion_notices.sql"),
    "utf8",
  );
  it("RLS forzada, sin privilegios de tabla y funciones solo para service_role", () => {
    expect(sql).toContain("enable row level security");
    expect(sql).toContain("force row level security");
    expect(sql).toMatch(
      /revoke all on public\.account_deletion_completion_notices from public, anon, authenticated, service_role/,
    );
    expect(sql).not.toMatch(/create policy/i);
    const fns = [...sql.matchAll(/^create function public\.(\w+)/gm)].map((m) => m[1]);
    expect(fns).toHaveLength(4);
    for (const f of fns) {
      expect(sql).toMatch(
        new RegExp(
          `revoke execute on function public\\.${f}\\([^)]*\\) from public, anon, authenticated;`,
        ),
      );
      expect(sql).toMatch(
        new RegExp(`grant execute on function public\\.${f}\\([^)]*\\) to service_role;`),
      );
    }
    expect(
      sql.match(/security definer set search_path = pg_catalog, public/g),
    ).toHaveLength(5);
  });
  it("envío solo con la solicitud completada, reclamación atómica y correo borrado al terminar", () => {
    expect(sql).toContain("q.status = 'completed' and q.completed_at is not null");
    expect(sql).toContain("for update of n skip locked");
    expect(sql).toContain("recipient = null, sent_at = v_now");
    expect(sql).toContain("interval '14 days'");
    expect(sql).toContain("interval '23 hours'");
  });
  it("solo redefine el conteo del despertador y no toca tablas ni RPC de confirmación/etapas", () => {
    expect(sql).not.toMatch(/alter table public\.account_deletion_requests/i);
    const replaced = [...sql.matchAll(/create or replace function public\.(\w+)/gi)].map(
      (m) => m[1],
    );
    expect(replaced).toEqual(["account_deletion_backlog"]); // única función de DEL-2 que se redefine
    expect(sql).toContain("r.status = 'access_blocked'"); // la condición de limpieza se conserva
    expect(sql).not.toMatch(
      /drop (function|table) (if exists )?public\.account_deletion_(request|confirm|step|claim)/i,
    );
  });
});
