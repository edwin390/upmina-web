// @vitest-environment node
// Structural guarantees only. DELETE/KEY SHARE waits require independent Testing connections.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, it } from "vitest";

const applied = readFileSync(
  resolve("supabase/migrations/20261011120000_community_report_submission.sql"),
);
const fix = readFileSync(
  resolve(
    "supabase/migrations/20261012120000_community_report_submission_account_race_fix.sql",
  ),
  "utf8",
);
const body = fix.match(/as \$\$([\s\S]*?)\$\$;/)![1];

// Guard de inmutabilidad: CRLF y LF son el mismo contenido (autocrlf cambia los finales de línea
// del working tree). SOLO se normaliza CRLF a LF antes del SHA256; cualquier otro cambio rompe el hash.
function canonicalSha256(bytes: Uint8Array): string {
  const out: number[] = [];
  for (let i = 0; i < bytes.length; i++)
    if (!(bytes[i] === 13 && bytes[i + 1] === 10)) out.push(bytes[i]);
  return createHash("sha256").update(Uint8Array.from(out)).digest("hex");
}

it("canonical hashing: LF and CRLF are the same content, any real change is not", () => {
  const hash = (s: string) => canonicalSha256(Buffer.from(s, "utf8"));
  const lf = hash("select 1;\nselect 2;\n");
  expect(hash("select 1;\r\nselect 2;\r\n")).toBe(lf);
  expect(hash("select 1;\r\nselect 2;\n")).toBe(lf);
  expect(hash("select 1;\nselect 3;\n")).not.toBe(lf);
  expect(hash("select 1;\nselect 2;\n\n")).not.toBe(lf);
  expect(hash("select 1;\rselect 2;\n")).not.toBe(lf);
});

it("keeps the already-applied R2 artifact content-identical (CRLF/LF-insensitive)", () => {
  expect(canonicalSha256(applied)).toBe(
    "b80ce5dd8714d659626903b4be53fed56fbbbb54483b9e650a07f2c8e452c059",
  );
});

it("locks only the current reporter with KEY SHARE before post/case/report locks", () => {
  const identity = body.indexOf(
    "perform 1 from auth.users where id = p_reporter_user_id for key share",
  );
  const post = body.indexOf("where id = p_post_id for update");
  const caseLock = body.indexOf("where post_id = p_post_id for update");
  const reports = body.indexOf("order by id for update");
  expect(identity).toBeGreaterThan(0);
  expect(post).toBeGreaterThan(identity);
  expect(caseLock).toBeGreaterThan(post);
  expect(reports).toBeGreaterThan(caseLock);
  expect(body.match(/for key share/g)).toHaveLength(1);
  expect(body).not.toMatch(/auth\.users[^;]*for (?:update|share)\b/);
});

it("rejects a missing locked identity before any publication/history mutation", () => {
  expect(body).toMatch(
    /perform 1 from auth\.users[^;]*for key share;\s*if not found then\s*raise exception 'unauthenticated';/,
  );
  expect(body.indexOf("raise exception 'unauthenticated'")).toBeLessThan(
    body.indexOf("select * into v_post"),
  );
  expect(body).toMatch(/join auth\.users u on u\.id = r\.reporter_user_id/);
});

it("retains controlled definer security and service-only EXECUTE", () => {
  expect(fix).toMatch(/security definer\s+set search_path = pg_catalog, public/);
  expect(fix).toMatch(/alter function[^;]*owner to postgres;/);
  expect(fix).toMatch(
    /revoke all on function[^;]*from public, anon, authenticated, service_role;/,
  );
  expect(fix).toMatch(/grant execute on function[^;]*to service_role;/);
  expect(fix).not.toMatch(/grant[^;]*to (?:public|anon|authenticated)\b/i);
});

it("is forward-only and does not restore retired writers or apply historical DML", () => {
  const outsideBody = fix.replace(/as \$\$[\s\S]*?\$\$;/, "as <body>;");
  expect(fix.match(/create or replace function/g)).toHaveLength(1);
  expect(outsideBody).not.toMatch(
    /\b(?:insert into|update public\.|delete from|alter table|create trigger|grant insert|truncate)\b/i,
  );
  expect(fix).not.toMatch(/community_post_report_create|community_report_case_attach/);
});

it("changes only the identity lifetime check and optional context normalization", () => {
  const oldBody = applied.toString("utf8").match(/as \$\$([\s\S]*?)\$\$;/)![1];
  const strip = (sql: string) => sql.replace(/--[^\n]*/g, "").replace(/\s/g, "");
  const expected = oldBody
    .replace("  v_count integer;", "  v_count integer;\n  v_detail text;")
    .replace(
      /if p_reporter_user_id is null or not exists\s+\(select 1 from auth\.users where id = p_reporter_user_id\) then/,
      "perform 1 from auth.users where id = p_reporter_user_id for key share; if not found then",
    )
    .replace(
      "if char_length(p_detail) > 1000 then raise exception 'detail_too_long'; end if;",
      "if char_length(p_detail) > 1000 then raise exception 'detail_too_long'; end if; v_detail := nullif(btrim(p_detail), '');",
    )
    .replace(
      "p_reason, p_detail, 'open', v_case.id, v_cycle)",
      "p_reason, v_detail, 'open', v_case.id, v_cycle)",
    );
  expect(strip(body)).toBe(strip(expected));
});
