// @vitest-environment node
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { TestDatabase } from "./community-atomic-save-test-db";

// «Olvidé mi contraseña» — comprobación del correo + límites POR CAPAS. SQL REAL (PGlite) de la migración 20261105120000.
// auth.users es solo la FORMA mínima que usa la migración. No prueba GoTrue.

const MIGRATION = readFileSync(
  resolve("supabase/migrations/20261105120000_password_recovery_lookup.sql"),
  "utf8",
);
const ROLLBACK = readFileSync(
  resolve("supabase/rollbacks/20261105120000_password_recovery_lookup.rollback.sql"),
  "utf8",
);
const uid = (n: number) => `aaaaaaaa-aaaa-4aaa-8aaa-${String(n).padStart(12, "0")}`;
/** Clave de IP/red SINTÉTICA: el backend envía digests HMAC de 64 hex, nunca IPs. */
const key = (n: number) => n.toString(16).padStart(64, "0");
const NET = key(0xabc);

let db: TestDatabase;

beforeAll(async () => {
  const modulePath = process.env.UPMINA_TEST_PGLITE_MODULE;
  if (!modulePath) throw new Error("Set UPMINA_TEST_PGLITE_MODULE");
  const { PGlite } = await import(/* @vite-ignore */ modulePath);
  db = new PGlite();
  await db.exec(`
    create role anon; create role authenticated; create role service_role;
    create schema auth;
    create table auth.users(id uuid primary key, email text, email_confirmed_at timestamptz,
      deleted_at timestamptz);
  `);
  // Supabase concede EXECUTE por defecto a anon, authenticated y service_role en las funciones nuevas de public: se reproduce
  // para que los REVOKE explícitos de la migración sean lo que realmente cierra el acceso (no un valor por defecto del test).
  await db.exec(
    "alter default privileges in schema public grant execute on functions to anon, authenticated, service_role",
  );
  await db.exec(MIGRATION);
}, 90000);
afterAll(async () => {
  await db?.close();
});
beforeEach(async () => {
  await db.exec("begin");
  await db.query(
    `insert into auth.users(id,email,email_confirmed_at,deleted_at) values
       ($1,'confirmada@example.test',now(),null),
       ($2,'pendiente@example.test',null,null),
       ($3,'borrada@example.test',now(),now())`,
    [uid(1), uid(2), uid(3)],
  );
});
afterEach(async () => {
  await db.exec("reset role;rollback");
});

type J = { status: string; retryAfterSeconds?: number };
const lookup = async (
  email: string | null,
  ip: string | null = key(1),
  net: string | null = NET,
): Promise<J> =>
  (
    await db.query<{ r: J }>("select public.auth_email_lookup($1,$2,$3) r", [
      email,
      ip,
      net,
    ])
  ).rows[0].r;
const count = async (sql: string, params: unknown[] = []) =>
  Number(
    (await db.query<{ n: string }>(`select count(*)::text n ${sql}`, params)).rows[0].n,
  );
/** n cuentas CONFIRMADAS distintas (v0@…, v1@…): consultas de volumen que no cuentan como fallos. */
const seedConfirmed = (n: number) =>
  db.query(
    `insert into auth.users(id,email,email_confirmed_at)
       select gen_random_uuid(), 'v'||g||'@example.test', now() from generate_series(0,$1::int-1) g`,
    [n],
  );
const v = (i: number) => `v${i}@example.test`;
/** Abre una ventana nueva de 10 min en los contadores de 10 min (simula el paso del tiempo sin esperar). */
const rollTenMinutes = () =>
  db.exec(
    "update public.auth_lookup_limits set window_start = window_start - interval '10 minutes' where scope in ('ip10','net10','miss10')",
  );
async function fails(run: () => Promise<unknown>, pattern: RegExp) {
  await db.exec("savepoint expected");
  let err: unknown = null;
  try {
    await run();
  } catch (e) {
    err = e;
  }
  await db.exec("rollback to savepoint expected");
  expect(err).not.toBeNull();
  expect(String((err as Error).message)).toMatch(pattern);
}

describe("estados del correo", () => {
  it("confirmed / unconfirmed / none, y SOLO devuelve {status}: nada de auth.users", async () => {
    const confirmed = await lookup("confirmada@example.test");
    expect(confirmed).toEqual({ status: "confirmed" });
    expect(await lookup("pendiente@example.test", key(2))).toEqual({
      status: "unconfirmed",
    });
    expect(await lookup("nadie@example.test", key(3))).toEqual({ status: "none" });
    expect(Object.keys(confirmed)).toEqual(["status"]);
    expect(JSON.stringify(confirmed)).not.toMatch(/aaaaaaaa|example/);
  });

  it("normaliza (mayúsculas y espacios) y la búsqueda es EXACTA: ni prefijos, ni comodines, ni subcadenas", async () => {
    expect(await lookup("  CONFIRMADA@Example.TEST  ", key(4))).toEqual({
      status: "confirmed",
    });
    for (const [i, probe] of [
      "confirmada@example.tes",
      "onfirmada@example.test",
      "confirmada@example.test.evil",
      "confirm%@example.test",
      "confirmad_@example.test",
      "a@b.c",
    ].entries()) {
      expect(await lookup(probe, key(10 + i)), probe).toEqual({ status: "none" });
    }
  });

  it("una cuenta borrada cuenta como inexistente", async () => {
    expect(await lookup("borrada@example.test", key(5))).toEqual({ status: "none" });
  });

  it("formas inválidas → invalid, SIN consumir cuota ni crear contadores", async () => {
    for (const bad of [
      "",
      "   ",
      "sin-arroba",
      "a@b",
      "a b@c.d",
      "a@@b.c",
      "x".repeat(250) + "@e.co",
      "a\n@b.co",
    ]) {
      expect(await lookup(bad, key(6)), bad).toEqual({ status: "invalid" });
    }
    expect(await count("from public.auth_lookup_limits")).toBe(0);
  });

  it("argumentos nulos o claves que no son digests: error (no se interpreta como inexistente)", async () => {
    await fails(() => lookup(null), /invalid_argument/);
    await fails(() => lookup("confirmada@example.test", null), /invalid_argument/);
    await fails(
      () => lookup("confirmada@example.test", key(1), null),
      /invalid_argument/,
    );
    for (const bad of [
      "203.0.113.7",
      "x".repeat(64),
      key(0xabc).toUpperCase(),
      "",
      "unknownx",
    ]) {
      await fails(() => lookup("confirmada@example.test", bad), /invalid_argument/);
      await fails(
        () => lookup("confirmada@example.test", key(1), bad),
        /invalid_argument/,
      );
    }
    expect((await lookup("nadie@example.test", "unknown", "unknown")).status).toBe(
      "none",
    );
  });
});

describe("capa 1 — volumen por IP", () => {
  it("20 consultas / 10 min por IP; la 21.ª → rate_limited con retryAfterSeconds; otra IP no se ve afectada", async () => {
    await seedConfirmed(30);
    for (let i = 0; i < 20; i++) {
      expect((await lookup(v(i), key(7), key(1000 + i))).status, String(i)).toBe(
        "confirmed",
      );
    }
    const limited = await lookup(v(21), key(7), key(2000));
    expect(limited.status).toBe("rate_limited");
    expect(limited.retryAfterSeconds).toBeGreaterThanOrEqual(1);
    expect(limited.retryAfterSeconds).toBeLessThanOrEqual(600);
    expect((await lookup(v(22), key(8), key(2001))).status).toBe("confirmed");
  });

  it("100 consultas / hora por IP aunque cambie la ventana de 10 min", async () => {
    await seedConfirmed(110);
    for (let batch = 0; batch < 5; batch++) {
      for (let i = 0; i < 20; i++) {
        expect(
          (await lookup(v(batch * 20 + i), key(9), key(3000 + batch * 20 + i))).status,
        ).toBe("confirmed");
      }
      await rollTenMinutes();
    }
    const limited = await lookup(v(105), key(9), key(4000));
    expect(limited.status).toBe("rate_limited");
    expect(limited.retryAfterSeconds).toBeLessThanOrEqual(3600);
  });

  it("la ventana vence: tras pasar los 10 min se vuelve a permitir", async () => {
    await seedConfirmed(25);
    for (let i = 0; i < 21; i++) await lookup(v(i), key(11), key(5000 + i));
    expect((await lookup(v(22), key(11), key(5100))).status).toBe("rate_limited");
    await rollTenMinutes();
    expect((await lookup(v(23), key(11), key(5101))).status).toBe("confirmed");
  });

  it("IP desconocida: bucket propio con los mismos límites y sin capa de red", async () => {
    await seedConfirmed(130);
    for (let i = 0; i < 20; i++) {
      expect((await lookup(v(i), "unknown", "unknown")).status).toBe("confirmed");
    }
    expect((await lookup(v(21), "unknown", "unknown")).status).toBe("rate_limited");
    // sin capa de red: 110 IPs distintas con red «unknown» no se limitan entre sí
    for (let i = 0; i < 110; i++) {
      expect((await lookup(v(i), key(6000 + i), "unknown")).status, String(i)).toBe(
        "confirmed",
      );
    }
    expect(await count("from public.auth_lookup_limits where scope = 'net10'")).toBe(0);
  });

  it("atómico: 25 peticiones simultáneas de la misma IP → exactamente 20 permitidas y 5 limitadas", async () => {
    await seedConfirmed(30);
    const results = await Promise.all(
      Array.from({ length: 25 }, (_, i) => lookup(v(i), key(12), key(7000 + i))),
    );
    expect(results.filter((r) => r.status === "confirmed")).toHaveLength(20);
    expect(results.filter((r) => r.status === "rate_limited")).toHaveLength(5);
    const hits = (
      await db.query<{ h: number }>(
        "select max(hits) h from public.auth_lookup_limits where scope = 'ip10'",
      )
    ).rows[0].h;
    expect(hits).toBe(25);
  });
});

describe("capa 2 — volumen por red (/24 IPv4, /48 IPv6)", () => {
  it("100 consultas / 10 min por red aunque cada una venga de una IP distinta", async () => {
    await seedConfirmed(110);
    for (let i = 0; i < 100; i++) {
      expect((await lookup(v(i), key(8000 + i), NET)).status, String(i)).toBe(
        "confirmed",
      );
    }
    const limited = await lookup(v(101), key(9000), NET);
    expect(limited.status).toBe("rate_limited");
    expect(limited.retryAfterSeconds).toBeLessThanOrEqual(600);
    // otra red no se ve afectada
    expect((await lookup(v(102), key(9001), key(0xdef))).status).toBe("confirmed");
  });
});

describe("capa 3 — fallos (enumeración) por IP", () => {
  it("8 fallos / 10 min por IP; el 9.º rechaza TODO desde esa IP (acierte o no); otra IP no se ve afectada", async () => {
    for (let i = 0; i < 8; i++) {
      expect(
        (await lookup(`nadie${i}@example.test`, key(20), key(9100 + i))).status,
      ).toBe("none");
    }
    const missed = await lookup("nadie9@example.test", key(20), key(9200));
    const hit = await lookup("confirmada@example.test", key(20), key(9201));
    expect(missed.status).toBe("rate_limited");
    expect(hit.status).toBe("rate_limited");
    // el rechazo no distingue un correo existente de uno inexistente
    expect(Object.keys(missed).sort()).toEqual(Object.keys(hit).sort());
    expect((await lookup("confirmada@example.test", key(21), key(9202))).status).toBe(
      "confirmed",
    );
    expect((await lookup("nadie@example.test", key(21), key(9203))).status).toBe("none");
  });

  it("las cuentas sin confirmar también cuentan como fallo", async () => {
    for (let i = 0; i < 8; i++) {
      expect(
        (await lookup("pendiente@example.test", key(22), key(9300 + i))).status,
      ).toBe("unconfirmed");
    }
    expect((await lookup("pendiente@example.test", key(22), key(9400))).status).toBe(
      "rate_limited",
    );
  });

  it("los aciertos NO cuentan como fallo: 15 consultas confirmadas no consumen el cupo de fallos", async () => {
    await seedConfirmed(20);
    for (let i = 0; i < 15; i++) await lookup(v(i), key(23), key(9500 + i));
    expect(
      await count("from public.auth_lookup_limits where scope = 'miss10' and hits > 0"),
    ).toBe(0);
    for (let i = 0; i < 5; i++) {
      expect(
        (await lookup(`nadie${i}@example.test`, key(24), key(9600 + i))).status,
      ).toBe("none");
    }
  });

  it("atómico: 15 fallos simultáneos de la misma IP → exactamente 8 contados y 7 rechazados", async () => {
    const results = await Promise.all(
      Array.from({ length: 15 }, (_, i) =>
        lookup(`nadie${i}@example.test`, key(25), key(9700 + i)),
      ),
    );
    expect(results.filter((r) => r.status === "none")).toHaveLength(8);
    expect(results.filter((r) => r.status === "rate_limited")).toHaveLength(7);
    expect(
      (
        await db.query<{ h: number }>(
          "select max(hits) h from public.auth_lookup_limits where scope = 'miss10'",
        )
      ).rows[0].h,
    ).toBe(8);
  });

  it("el cupo de fallos se renueva con la ventana", async () => {
    for (let i = 0; i < 9; i++)
      await lookup(`nadie${i}@example.test`, key(26), key(9800 + i));
    expect((await lookup("nadie@example.test", key(26), key(9900))).status).toBe(
      "rate_limited",
    );
    await rollTenMinutes();
    expect((await lookup("nadie@example.test", key(26), key(9901))).status).toBe("none");
  });
});

describe("capa 4 — cuota del correo: solo cuentan las consultas que acaban en un correo de recuperación", () => {
  it("5 consultas «confirmed» / hora por correo aunque cambie la IP; la 6.ª → rate_limited; el correo se normaliza", async () => {
    for (let i = 0; i < 5; i++) {
      expect(
        (await lookup("confirmada@example.test", key(30 + i), key(9950 + i))).status,
      ).toBe("confirmed");
    }
    const limited = await lookup(" CONFIRMADA@example.test ", key(40), key(9960));
    expect(limited.status).toBe("rate_limited");
    expect(limited.retryAfterSeconds).toBeLessThanOrEqual(3600);
  });

  it("consultar correos inexistentes o sin confirmar NUNCA gasta la cuota del correo (no se puede agotar la de una víctima probando)", async () => {
    for (let i = 0; i < 40; i++) {
      expect(
        (await lookup("pendiente@example.test", key(100 + i), key(10000 + i))).status,
      ).toBe("unconfirmed");
      expect(
        (await lookup("nadie@example.test", key(200 + i), key(11000 + i))).status,
      ).toBe("none");
    }
    expect(await count("from public.auth_lookup_limits where scope = 'email60'")).toBe(0);
    // la víctima sigue pudiendo recuperar
    expect((await lookup("confirmada@example.test", key(300), key(12000))).status).toBe(
      "confirmed",
    );
  });
});

describe("sin límite global", () => {
  it("480 consultas fallidas repartidas en 60 IPs/redes distintas no se bloquean entre sí (no hay contador global)", async () => {
    for (let ip = 0; ip < 60; ip++) {
      for (let i = 0; i < 8; i++) {
        const out = await lookup(
          `x${ip}-${i}@example.test`,
          key(20000 + ip),
          key(30000 + ip),
        );
        expect(out.status, `${ip}/${i}`).toBe("none");
      }
    }
    expect(
      await count(
        "from public.auth_lookup_limits where scope not in ('ip10','ip60','net10','miss10','email60')",
      ),
    ).toBe(0);
    expect(MIGRATION).not.toMatch(/'global'/);
  });
});

describe("almacenamiento mínimo y retención", () => {
  it("las tablas solo guardan digests de 64 hex: ni correos ni IPs en claro", async () => {
    await lookup("confirmada@example.test", key(0xdeadbeef), key(0xcafe));
    await lookup("nadie@example.test", key(0xfeed), key(0xcafe));
    const rows = (
      await db.query<{ scope: string; key_digest: string; hits: number }>(
        "select scope, key_digest, hits from public.auth_lookup_limits",
      )
    ).rows;
    expect(rows.length).toBeGreaterThanOrEqual(6);
    for (const r of rows) expect(r.key_digest).toMatch(/^[0-9a-f]{64}$/);
    const dump = JSON.stringify(rows);
    expect(dump).not.toMatch(/example|confirmada|nadie|deadbeef|cafe/);
    const salt = (
      await db.query<{ s: string }>("select salt s from public.auth_lookup_salt")
    ).rows;
    expect(salt).toHaveLength(1);
    expect(salt[0].s.length).toBeGreaterThanOrEqual(64);
    // los digests dependen de la sal: ni la clave de IP ni el correo aparecen con un SHA-256 «a pelo»
    const naive = (
      await db.query<{ a: string; b: string }>(
        `select encode(sha256(convert_to('confirmada@example.test','utf8')),'hex') a,
                encode(sha256(convert_to($1::text,'utf8')),'hex') b`,
        [key(0xdeadbeef)],
      )
    ).rows[0];
    const digests = rows.map((r) => r.key_digest);
    expect(digests).not.toContain(naive.a);
    expect(digests).not.toContain(naive.b);
    expect(digests).not.toContain(key(0xdeadbeef));
  });

  it("la misma IP/correo produce el mismo digest (el contador se acumula) y dos IPs, digests distintos", async () => {
    await seedConfirmed(3);
    await lookup(v(0), key(1), key(5000));
    await lookup(v(1), key(1), key(5000));
    await lookup(v(2), key(2), key(5001));
    expect(await count("from public.auth_lookup_limits where scope = 'ip10'")).toBe(2);
    expect(await count("from public.auth_lookup_limits where scope = 'net10'")).toBe(2);
    expect(await count("from public.auth_lookup_limits where scope = 'email60'")).toBe(3);
  });

  it("retención: borra las ventanas de más de 2 días, como máximo 100 por llamada", async () => {
    await db.exec(`
      insert into public.auth_lookup_limits(scope,key_digest,window_start,hits)
      select 'ip10', encode(sha256(convert_to(g::text,'utf8')),'hex'), now() - interval '3 days', 1
        from generate_series(1,150) g;
      insert into public.auth_lookup_limits(scope,key_digest,window_start,hits)
      values ('ip10', repeat('a',64), now() - interval '1 day', 1);
    `);
    await lookup("nadie@example.test", key(50), key(51));
    const old = () =>
      count(
        "from public.auth_lookup_limits where window_start < now() - interval '2 days'",
      );
    expect(await old()).toBe(50);
    await lookup("nadie@example.test", key(52), key(53));
    expect(await old()).toBe(0);
    expect(
      await count("from public.auth_lookup_limits where key_digest = repeat('a',64)"),
    ).toBe(1);
  });
});

describe("privilegios", () => {
  it("las funciones son SECURITY DEFINER con search_path fijo; solo service_role ejecuta la pública y NADIE el ayudante", async () => {
    for (const name of ["auth_email_lookup", "auth_lookup_hit_"]) {
      const f = (
        await db.query<{ secdef: boolean; cfg: string[] }>(
          "select prosecdef secdef, proconfig cfg from pg_proc where proname = $1",
          [name],
        )
      ).rows[0];
      expect(f.secdef, name).toBe(true);
      expect(f.cfg, name).toContain("search_path=pg_catalog, public");
    }
    const can = async (role: string, fn: string) =>
      (
        await db.query<{ p: boolean }>(
          "select has_function_privilege($1,$2::regprocedure,'execute') p",
          [role, fn],
        )
      ).rows[0].p;
    const pub = "public.auth_email_lookup(text,text,text)";
    const helper = "public.auth_lookup_hit_(text,text,interval,integer,timestamptz)";
    expect(await can("anon", pub)).toBe(false);
    expect(await can("authenticated", pub)).toBe(false);
    expect(await can("service_role", pub)).toBe(true);
    for (const role of ["anon", "authenticated", "service_role"]) {
      expect(await can(role, helper), `${role} no ejecuta el ayudante`).toBe(false);
    }
  });

  it("las tablas son privadas: RLS + FORCE RLS y ningún privilegio para anon, authenticated ni service_role", async () => {
    for (const table of ["auth_lookup_limits", "auth_lookup_salt"]) {
      const flags = (
        await db.query<{ rls: boolean; force: boolean }>(
          "select relrowsecurity rls, relforcerowsecurity force from pg_class where relname = $1",
          [table],
        )
      ).rows[0];
      expect(flags, table).toEqual({ rls: true, force: true });
      for (const role of ["anon", "authenticated", "service_role"]) {
        for (const priv of ["select", "insert", "update", "delete"]) {
          expect(
            (
              await db.query<{ p: boolean }>("select has_table_privilege($1,$2,$3) p", [
                role,
                `public.${table}`,
                priv,
              ])
            ).rows[0].p,
            `${role} ${priv} ${table}`,
          ).toBe(false);
        }
      }
    }
  });

  it("anon, authenticated y service_role NO pueden llamar al ayudante ni leer la sal; anon y authenticated tampoco a la función pública", async () => {
    for (const role of ["anon", "authenticated", "service_role"]) {
      await db.exec(`set local role ${role}`);
      await fails(
        () =>
          db.query(
            "select public.auth_lookup_hit_('ip10', repeat('a',64), interval '1 hour', 5, now())",
          ),
        /permission denied/,
      );
      await fails(
        () => db.query("select salt from public.auth_lookup_salt"),
        /permission denied/,
      );
      if (role !== "service_role") {
        await fails(
          () =>
            db.query("select public.auth_email_lookup('a@b.co', 'unknown', 'unknown')"),
          /permission denied/,
        );
      }
      await db.exec("reset role");
    }
  });

  it("service_role SÍ puede usar la función pública (única vía)", async () => {
    await db.exec("set local role service_role");
    expect((await lookup("nadie@example.test", key(60), key(61))).status).toBe("none");
  });

  it("la migración solo crea sus objetos: no toca auth, no concede nada a anon/authenticated y no crea usuarios", async () => {
    expect(MIGRATION).not.toMatch(
      /alter table auth\.|insert into auth\.|update auth\.|delete from auth\./i,
    );
    expect(MIGRATION).not.toMatch(/grant [^;]*\b(anon|authenticated)\b/i);
    expect(MIGRATION).not.toMatch(/\bcreate (user|role)\b/i);
    expect(await count("from auth.users")).toBe(3);
  });
});

describe("serialización de los fallos por IP", () => {
  it("la fila de fallos se lee con FOR UPDATE (peticiones simultáneas de una IP se serializan; PGlite tiene una sola conexión, así que se comprueba la sentencia)", () => {
    expect(MIGRATION).toMatch(
      /select l\.hits into v_miss_hits from public\.auth_lookup_limits l\s+where l\.scope = 'miss10'[\s\S]*?for update;/,
    );
    // y el contador de fallos solo se incrementa DESPUÉS de la consulta, sobre la fila ya bloqueada
    expect(MIGRATION.indexOf("for update;")).toBeLessThan(
      MIGRATION.indexOf("from auth.users u"),
    );
  });
});

describe("rollback", () => {
  it("elimina las dos funciones y las dos tablas, y la migración se puede volver a aplicar", async () => {
    await db.exec(ROLLBACK);
    expect(
      await count(
        "from pg_proc where proname in ('auth_email_lookup','auth_lookup_hit_')",
      ),
    ).toBe(0);
    expect(
      await count(
        "from pg_class where relname in ('auth_lookup_limits','auth_lookup_salt')",
      ),
    ).toBe(0);
    await db.exec(MIGRATION);
    expect(await lookup("confirmada@example.test", key(70), key(71))).toEqual({
      status: "confirmed",
    });
  });
});
