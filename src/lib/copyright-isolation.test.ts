// @vitest-environment node
import { readFileSync, readdirSync, statSync } from "node:fs";
import { describe, expect, it } from "vitest";

// COPY-1 fase 2A: aislamiento. Crear, consultar y REVISAR reclamaciones no toca el circuito ordinario ni retira, restaura,
// purga o borra nada, no usa R2 ni envía correo, no añade funciones serverless y no admite archivos. Comprobaciones
// estructurales del código; el comportamiento real está en los tests SQL, de handlers y de interfaz.
const read = (p: string) => readFileSync(p, "utf8").replace(/\r\n/g, "\n");
const MIGRATION = read("supabase/migrations/20261107120000_copyright_claims.sql");
const ROLLBACK = read("supabase/rollbacks/20261107120000_copyright_claims.rollback.sql");
const DISPATCHER = read("api/admin/[action].ts");
// Piezas de la fase 2A que siguen sin conocer publicaciones, medios ni correo (el contrato y el cliente compartidos ganaron los tipos
// y llamadas de la 2B: las cubre el bloque «fase 2B» de más abajo).
const SERVER = ["src/lib/copyright-handlers.ts", "src/lib/copyright-claim.ts"];
// (El panel de moderación monta además la sección de retirada y la de strikes manuales: ya no es «2A pura» y lo cubre el bloque de
// strikes de más abajo.)
const BROWSER = ["src/pages/CopyrightClaimPage.tsx"];
const code = (file: string) =>
  read(file)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");

describe("la fase 2A no retira, restaura, purga ni borra", () => {
  it("el código de servidor y de navegador no menciona publicaciones, medios, R2, purga, correo ni strikes", () => {
    for (const file of [...SERVER, ...BROWSER]) {
      expect(code(file), file).not.toMatch(
        /community_posts|community_post_media|media_assets|purge|removed_pending|restore|r2-client|\bR2\b|resend|nodemailer|sendMail|mfa-recovery-mail|strike|moderation-report|community_moderation/i,
      );
    }
  });

  it("las acciones de revisión no incluyen ninguna que retire u oculte", () => {
    const contract = code("src/lib/copyright-contract.ts");
    const actions = contract.match(/REVIEW_ACTIONS = \[([\s\S]*?)\] as const/)![1];
    expect(actions).not.toMatch(/remove|hide|restore|purge|uphold|delete/i);
    const statuses = contract.match(/CLAIM_STATUSES = \[([\s\S]*?)\] as const/)![1];
    // Los cuatro estados de la fase 2B (retirada, apelación, restauración y eliminación) los produce SOLO su propia acción.
    expect(statuses.match(/"[a-z_]+"/g)).toEqual([
      '"received"',
      '"in_review"',
      '"needs_info"',
      '"dismissed"',
      '"withdrawn"',
      '"removed"',
      '"appeal_pending"',
      '"restored"',
      '"purged"',
      // DEL-2: cierre técnico por eliminación de la cuenta autora; lo escribe SOLO la etapa copyright_claims del ejecutor.
      '"author_deleted"',
    ]);
  });

  it("la migración solo escribe en sus propias tablas y en el historial general; nunca en el circuito ordinario", () => {
    const writes = [
      ...MIGRATION.matchAll(
        /\b(insert into|update|delete from)\s+(?:only\s+)?([\w.]+)/gi,
      ),
    ].map((m) => m[2].toLowerCase());
    const allowed = new Set([
      "public.copyright_claims",
      "public.copyright_claim_events",
      "public.copyright_claim_limits",
      "public.moderation_audit_log",
      "l", // alias de copyright_claim_limits en el borrado de retención
      "or", // «before update or delete on …» (disparador de inmutabilidad), no un destino de escritura
      "set", // «do update set hits = …» del UPSERT de los contadores
    ]);
    for (const target of writes) expect(allowed, target).toContain(target);
    expect(MIGRATION).not.toMatch(
      /(insert into|update|delete from|alter table|truncate)\s+public\.(community_|media_|cosplay_|profiles|admin_|auth)/i,
    );
    // Solo LEE publicaciones (copia congelada y estado actual); no usa programador, red ni Vault.
    expect(MIGRATION).toMatch(/from public\.community_posts/);
    expect(MIGRATION).not.toMatch(/pg_cron|cron\.schedule|net\.http|vault\.|http_post/i);
    expect(MIGRATION).not.toMatch(
      /removed_pending_purge|purge_after|interval '\d+ hours?' *\)? *then/i,
    );
  });

  it("la única alteración de objetos existentes es ampliar los CHECK del historial general", () => {
    const alters = [...MIGRATION.matchAll(/alter table (public\.[\w]+)/gi)].map(
      (m) => m[1],
    );
    const own = [
      "public.copyright_claims",
      "public.copyright_claim_events",
      "public.copyright_claim_limits",
    ];
    for (const table of alters)
      expect([...own, "public.moderation_audit_log"], table).toContain(table);
    expect(MIGRATION).not.toMatch(
      /drop (table|function|trigger) (?!if)public\.(community|moderation_audit|admin)/i,
    );
    // El rollback restaura exactamente las listas anteriores y se niega si ya hay datos.
    expect(ROLLBACK).toMatch(/rollback_blocked_claims_exist/);
    expect(ROLLBACK).toMatch(/rollback_blocked_copyright_audit_rows/);
  });
});

describe("superficie pública y límites", () => {
  it("api/ conserva las mismas 12 funciones y no hay ninguna de copyright", () => {
    const entries = readdirSync("api").flatMap((name) =>
      statSync(`api/${name}`).isDirectory()
        ? readdirSync(`api/${name}`).map((f) => `api/${name}/${f}`)
        : [`api/${name}`],
    );
    expect(entries.filter((f) => f.endsWith(".ts"))).toHaveLength(12);
    expect(entries.some((f) => /copyright|claim|dmca/i.test(f))).toBe(false);
  });

  it("las acciones de copyright (2A y 2B) viven en el dispatcher existente y el resto de rutas no cambia de comportamiento", () => {
    for (const [action, handler] of [
      ["copyright-claim-create", "handleCopyrightClaimCreate"],
      ["copyright-claims", "handleCopyrightClaims"],
      ["copyright-claim", "handleCopyrightClaim"],
      ["copyright-claim-review", "handleCopyrightClaimReview"],
      ["copyright-claim-remove", "handleCopyrightClaimRemove"],
      ["copyright-claim-notice", "handleCopyrightClaimNotice"],
      ["copyright-claim-appeal-resolve", "handleCopyrightAppealResolve"],
      ["copyright-claim-purge", "handleCopyrightClaimPurge"],
      ["copyright-appeal-context", "handleCopyrightAppealContext"],
      ["copyright-appeal-submit", "handleCopyrightAppealSubmit"],
    ])
      expect(DISPATCHER).toContain(
        `case "${action}":\n      return ${handler}(req, res);`,
      );
    expect(DISPATCHER).toMatch(/default:\s+return res\.status\(404\)/);
  });

  it("solo la creación es pública; cola, detalle y revisión exigen la capacidad de moderación", () => {
    const handlers = code("src/lib/copyright-handlers.ts");
    const section = (name: string) => {
      const start = handlers.indexOf(`export async function ${name}(`);
      const rest = handlers.slice(start + 10);
      const end = rest.search(/\n(?:export |async function |function |const )/);
      return handlers.slice(start, end === -1 ? undefined : start + 10 + end);
    };
    const create = section("handleCopyrightClaimCreate");
    expect(create).not.toMatch(
      /requireCapability|requireAuthenticated|authorizeModerator/,
    );
    expect(create).toMatch(/application\/json/);
    for (const name of [
      "handleCopyrightClaims",
      "handleCopyrightClaim",
      "handleCopyrightClaimReview",
    ])
      expect(section(name), name).toMatch(/authorizeModerator\(req, res\)/);
    expect(handlers).toMatch(/requireCapability\(req, "moderation"\)/);
    // El actor SIEMPRE sale de la identidad verificada, nunca del cuerpo ni de la consulta.
    expect(handlers).not.toMatch(/(?:body|req\.query)\.(?:actor|userId|actorUserId)/);
  });

  it("los handlers no registran nada y la clave de servicio solo se usa como material de HMAC y cliente RPC", () => {
    const handlers = code("src/lib/copyright-handlers.ts");
    expect(handlers).not.toMatch(/console\./);
    expect(handlers.match(/SUPABASE_SERVICE_ROLE_KEY/g)).toHaveLength(1);
    for (const file of [
      ...BROWSER,
      "src/lib/copyright-contract.ts",
      "src/lib/copyright-claim.ts",
    ])
      expect(code(file), file).not.toMatch(/SERVICE_ROLE|service_role|process\.env/);
  });

  it("no hay subida de archivos: ni <input type=file>, ni FormData, ni R2 ni URLs prefirmadas", () => {
    for (const file of [...BROWSER, ...SERVER])
      expect(code(file), file).not.toMatch(
        /type="file"|type='file'|FormData|presign|multipart|Blob\(/,
      );
  });

  it("el formulario público se enlaza desde el pie y tiene su ruta, sin sesión ni cabecera de autenticación", () => {
    expect(read("src/components/layout/FooterLegal.tsx")).toMatch(/to="\/copyright"/);
    expect(read("src/App.tsx")).toMatch(
      /path="\/copyright" element=\{<CopyrightClaimPage \/>\}/,
    );
    const client = code("src/lib/copyright-client.ts");
    const submit = client.slice(
      client.indexOf("export async function submitCopyrightClaim"),
      client.indexOf("async function authHeader"),
    );
    expect(submit).toMatch(/credentials: "omit"/);
    expect(submit).not.toMatch(/Authorization|authHeader|getSession/);
  });

  it("los reportes ordinarios de Community siguen sin ofrecer copyright como motivo", () => {
    const reasons = read("src/lib/community-report.ts").match(
      /REPORT_REASONS[\s\S]*?\];/,
    )![0];
    expect(reasons).not.toMatch(/copyright/i);
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------
// Fase 2B: retirada, apelación, restauración y eliminación MANUAL. Estas comprobaciones estructurales fijan lo que 2B NO puede hacer.
const MIGRATION_2B = read(
  "supabase/migrations/20261110120000_copyright_removal_appeals.sql",
);
const ROLLBACK_2B = read(
  "supabase/rollbacks/20261110120000_copyright_removal_appeals.rollback.sql",
);
const REMOVAL_FILES = [
  "src/lib/copyright-removal-handlers.ts",
  "src/lib/copyright-mail.ts",
  "src/lib/copyright-appeal.ts",
  "src/lib/pending-appeal-token.ts",
  "src/pages/CopyrightAppealPage.tsx",
  "src/pages/admin/CopyrightRemovalSection.tsx",
];

describe("la fase 2B es siempre manual, acotada y sin procesos automáticos", () => {
  it("la migración solo escribe en las tablas de copyright, el historial general y, desde sus RPC, en publicaciones y archivos", () => {
    const body = MIGRATION_2B.replace(/^\s*--.*$/gm, "");
    const writes = [
      ...body.matchAll(/\b(insert into|update|delete from)\s+(?:only\s+)?([\w.]+)/gi),
    ].map((m) => m[2].toLowerCase());
    const allowed = new Set([
      "public.copyright_claims",
      "public.copyright_claim_events",
      "public.copyright_appeals",
      "public.moderation_audit_log",
      "public.community_posts",
      "public.media_assets",
      "a", // alias de media_assets en el UPDATE del marcado para el GC
      "skip", // «for update skip locked» de la purga programada ordinaria (sin cambios)
      "of", // «before update of status on …» (disparador de protección), no un destino de escritura
    ]);
    for (const target of writes) expect(allowed, target).toContain(target);
    // Nunca el circuito ordinario: ni reportes, casos, ciclos, decisiones, strikes ni medios de publicaciones.
    expect(body).not.toMatch(
      /(insert into|update|delete from|alter table|truncate)\s+public\.(community_post_reports|community_moderation|community_user_strike|community_post_media|cosplay_|profiles|admin_)/i,
    );
    expect(body).not.toMatch(/auth\.users\s+set|update\s+auth\./i);
    // Ocultar usa el estado 'hidden' existente: NUNCA la purga programada de 72 h, ni programadores, red o Vault.
    // (Fuera de la purga ordinaria que se copia sin cambios y del disparador que solo VIGILA ese estado.)
    const own = body
      .replace(
        /create or replace function public\.community_purge_due_posts\(.*?\n\$\$;\n/s,
        "",
      )
      .replace(/create trigger copyright_protect_post_removal.*?;\n/s, "");
    expect(own).not.toMatch(/removed_pending_purge|purge_after|removal_decision_id/i);
    expect(body).not.toMatch(/pg_cron|cron\.schedule|net\.http|vault\.|http_post/i);
  });

  it("solo toca publicaciones y archivos dentro de las RPC de retirada, apelación y eliminación, y siempre tras una acción humana", () => {
    const body = MIGRATION_2B.replace(/^\s*--.*$/gm, "");
    const functions = body.split(/create (?:or replace )?function /i).slice(1);
    const touching = functions.filter((f) =>
      /(update|delete from)\s+public\.(community_posts|media_assets)/i.test(f),
    );
    const names = touching.map((f) => /^public\.(\w+)/.exec(f)![1]).sort();
    // Las tres RPC de copyright, más las DOS funciones ordinarias que solo ganan la comprobación de protección (ver el test siguiente).
    expect(names).toEqual([
      "community_post_delete",
      "community_purge_due_posts",
      "copyright_appeal_resolve",
      "copyright_claim_purge",
      "copyright_claim_remove",
    ]);
    // Cada RPC de copyright verifica el rol de moderación bajo lock antes de actuar.
    for (const fn of touching.filter((f) => /^public\.copyright_/.test(f)))
      expect(fn).toMatch(
        /from public\.admin_roles where user_id = p_actor_user_id for share/,
      );
    // No se crea un segundo GC ni se tocan las funciones del GC de R2.
    expect(body).not.toMatch(/community_asset_gc/i);
  });

  it("la protección solo AÑADE una comprobación a las dos funciones ordinarias: el resto de su cuerpo es idéntico al original", () => {
    const fnText = (source: string, name: string) =>
      new RegExp(
        `create (?:or replace )?function public\\.${name}\\(.*?\\n\\$\\$;\\n`,
        "s",
      )
        .exec(source)![0]
        .replace("create or replace function", "create function");
    const lifecycle = read(
      "supabase/migrations/20261020120000_community_media_purge_lifecycle.sql",
    );
    const posts = read("supabase/migrations/20261004120000_community_posts_media.sql");
    const migratedPurge = fnText(MIGRATION_2B, "community_purge_due_posts").replace(
      /\n {6}-- COPY-1 2B:[^\n]*\n {6}or public\.copyright_post_protected\(v_post\.id\) then\n/,
      " then\n",
    );
    expect(migratedPurge).toBe(
      fnText(lifecycle, "community_purge_due_posts").replace(
        "      or not public.community_purge_due(v_post.purge_after, v_now) then",
        "      or not public.community_purge_due(v_post.purge_after, v_now) then",
      ),
    );
    const migratedDelete = fnText(MIGRATION_2B, "community_post_delete").replace(
      / {2}-- COPY-1 2B:[^\n]*\n {2}-- \(tampoco[^\n]*\n {2}if public\.copyright_post_protected\(p_post_id\) then\n {4}raise exception 'post_copyright_protected';\n {2}end if;\n/,
      "",
    );
    expect(migratedDelete).toBe(fnText(posts, "community_post_delete"));
    // El rollback devuelve exactamente las definiciones originales.
    expect(fnText(ROLLBACK_2B, "community_purge_due_posts")).toBe(
      fnText(lifecycle, "community_purge_due_posts"),
    );
    expect(fnText(ROLLBACK_2B, "community_post_delete")).toBe(
      fnText(posts, "community_post_delete"),
    );
  });

  it("la migración y su rollback solo alteran objetos de copyright y el historial general, y el rollback se niega si hay datos", () => {
    const alters = [...MIGRATION_2B.matchAll(/alter table (public\.\w+)/gi)].map(
      (m) => m[1],
    );
    for (const table of alters)
      expect(
        [
          "public.copyright_claims",
          "public.copyright_claim_events",
          "public.copyright_appeals",
          "public.moderation_audit_log",
        ],
        table,
      ).toContain(table);
    expect(MIGRATION_2B).not.toMatch(
      /drop (table|function|trigger) (?!if)public\.(community|moderation_audit|admin|media)/i,
    );
    expect(ROLLBACK_2B).toMatch(/rollback_blocked_removal_data_exists/);
    // Salvo las dos funciones ordinarias que restaura (sin la comprobación), el rollback no escribe en publicaciones ni archivos.
    const rollbackWithoutRestored = ROLLBACK_2B.replace(
      /create or replace function public\.(community_purge_due_posts|community_post_delete)\(.*?\n\$\$;\n/gs,
      "",
    );
    expect(rollbackWithoutRestored).not.toMatch(
      /(update|delete from|truncate)\s+public\.(community_|media_)/i,
    );
  });

  it("ningún código de 2B programa nada: ni cron, ni temporizadores, ni vencimiento que elimine", () => {
    for (const file of [
      "src/lib/copyright-removal-handlers.ts",
      "src/lib/copyright-mail.ts",
      "src/pages/admin/CopyrightRemovalSection.tsx",
    ])
      expect(code(file), file).not.toMatch(/setInterval|cron|schedule|setTimeout/i);
    expect(read("vercel.json")).not.toMatch(/crons/);
    // La eliminación solo existe como POST de un moderador con MFA; el plazo nunca la dispara.
    const handlers = code("src/lib/copyright-removal-handlers.ts");
    const purge = handlers.slice(
      handlers.indexOf("export async function handleCopyrightClaimPurge"),
      handlers.indexOf("export interface AppealContextBody"),
    );
    expect(purge).toMatch(/authorizeModerator\(req, res\)/);
    expect(purge).toMatch(/req\.method !== "POST"|prelude\(req, res\)/);
    expect(purge).not.toMatch(/Date\.now|new Date|deadline|appealDeadline/);
  });

  it("el plazo reducido solo puede salir de un entorno de pruebas explícito y de la variable de prueba; producción lo ignora", () => {
    const handlers = code("src/lib/copyright-removal-handlers.ts");
    expect(handlers).toMatch(
      /VERCEL_ENV === "preview" \|\| env\.VERCEL_ENV === "development"/,
    );
    expect(handlers).toMatch(/COPYRIGHT_TEST_WINDOW_MINUTES/);
    expect(handlers).not.toMatch(/VERCEL_ENV === "production"/);
    // El cliente nunca elige el plazo: el cuerpo de la retirada no admite esa clave y la RPC solo acepta 60 o 1440.
    expect(handlers).toMatch(/p_window_minutes: deps\.windowMinutes\(\)/);
    expect(MIGRATION_2B).toMatch(/p_window_minutes not in \(60, 1440\)/);
  });

  it("el correo es siempre en inglés, reutiliza el adaptador existente y no incluye datos del reclamante", () => {
    const mail = code("src/lib/copyright-mail.ts");
    expect(mail).toMatch(/from "\.\/mfa-recovery-mail\.js"/);
    expect(mail).not.toMatch(
      /claimantEmail|claimantName|claimant_|signature|api\.resend\.com|fetch\(/,
    );
    expect(code("src/lib/copyright-removal-handlers.ts")).not.toMatch(
      /api\.resend\.com|fetch\(/,
    );
  });

  it("2B no usa R2 ni URLs prefirmadas, no admite archivos y el actor sale siempre de la identidad verificada", () => {
    for (const file of REMOVAL_FILES) {
      expect(code(file), file).not.toMatch(
        /type="file"|type='file'|FormData|presign|multipart|Blob\(|r2-client|\bR2\b|S3Client/i,
      );
      expect(code(file), file).not.toMatch(/SERVICE_ROLE|service_role/);
    }
    const handlers = code("src/lib/copyright-removal-handlers.ts");
    expect(handlers).not.toMatch(
      /(?:body|req\.query)\.(?:actor|userId|actorUserId|authorId)/,
    );
    expect(handlers).not.toMatch(/console\./);
    expect(handlers).toMatch(/requireCapability\(req, "moderation"\)/);
    expect(handlers).toMatch(/requireAuthenticated\(req\)/);
  });

  it("los reportes ordinarios de Community no cambian: 2B no importa ni modifica su código", () => {
    for (const file of REMOVAL_FILES)
      expect(code(file), file).not.toMatch(
        /moderation-report|moderation-case|moderation-decision|moderation-strike|community-post-handlers|community-report/i,
      );
  });
});

describe("strikes manuales de Copyright", () => {
  const STRIKES_MIGRATION = read(
    "supabase/migrations/20261111120000_copyright_strikes.sql",
  );
  const walk = (dir: string): string[] =>
    readdirSync(dir).flatMap((name) => {
      const path = `${dir}/${name}`;
      return statSync(path).isDirectory() ? walk(path) : [path];
    });
  const productionFiles = [...walk("src"), ...walk("api")].filter(
    (f) => /\.(ts|tsx)$/.test(f) && !/\.test\.(ts|tsx)$/.test(f),
  );

  it("solo la RPC manual aplica strikes de Copyright: ningún otro código la llama ni inserta strikes", () => {
    const callers = productionFiles.filter((f) => /copyright_strike_apply/.test(code(f)));
    expect(callers).toEqual(["src/lib/copyright-removal-handlers.ts"]);
    const clientCallers = productionFiles.filter((f) =>
      /applyCopyrightStrike/.test(code(f)),
    );
    expect(clientCallers.sort()).toEqual([
      "src/lib/copyright-client.ts",
      "src/pages/admin/CopyrightStrikeSection.tsx",
    ]);
  });

  it("el panel solo monta la sección del strike con la reclamación en «purged» y nunca la aplica por sí mismo", () => {
    const panel = code("src/pages/admin/CopyrightClaimsPanel.tsx");
    expect(panel).toMatch(/claim\.status === "purged" && \(\s*<CopyrightStrikeSection/);
    expect(panel).not.toMatch(/applyCopyrightStrike|copyright_strike_apply/);
    // La eliminación definitiva (acción 2B) no sabe nada de strikes: son dos decisiones independientes.
    expect(code("src/pages/admin/CopyrightRemovalSection.tsx")).not.toMatch(/strike/i);
    const purgeHandler = code("src/lib/copyright-removal-handlers.ts").match(
      /export async function handleCopyrightClaimPurge[\s\S]*?\n}\n/,
    )![0];
    expect(purgeHandler).not.toMatch(/strike/i);
  });

  it("la migración no crea triggers sobre reclamaciones ni toca la RPC de eliminación o de resolución: no hay strikes automáticos", () => {
    expect(STRIKES_MIGRATION).not.toMatch(
      /create trigger[^;]*on public\.copyright_claims/i,
    );
    expect(STRIKES_MIGRATION).not.toMatch(
      /copyright_claim_purge|copyright_appeal_resolve|copyright_claim_remove/,
    );
    expect(STRIKES_MIGRATION).not.toMatch(/update public\.community_user_strikes/i);
    // La única condición de estado para insertar es `purged`, comprobada en la RPC y repetida por el trigger de contexto.
    expect(STRIKES_MIGRATION.match(/status <> 'purged'/g)!.length).toBeGreaterThanOrEqual(
      2,
    );
    expect(STRIKES_MIGRATION).toMatch(/c\.status = 'purged'/);
  });

  it("las funciones de strikes de Community no se redefinen: solo se amplían los dos triggers de la tabla", () => {
    expect(STRIKES_MIGRATION).not.toMatch(
      /function public\.(community_strike_apply|community_strike_revoke|community_author_restriction)/,
    );
    const redefined = [
      ...STRIKES_MIGRATION.matchAll(/create or replace function public\.(\w+)/g),
    ].map((m) => m[1]);
    expect(redefined.sort()).toEqual([
      "community_user_strikes_context_check",
      "community_user_strikes_immutable",
    ]);
  });

  it("el aviso del strike no lleva enlaces ni apelación y el código de aviso sigue siendo el generador existente", () => {
    const mail = code("src/lib/copyright-mail.ts");
    const strikeCase = mail.match(/case "strike": \{[\s\S]*?break;\s*\}/)![0];
    expect(strikeCase).not.toMatch(/appealLink|buildAppealLink|https?:/);
    expect(code("src/lib/copyright-removal-handlers.ts")).toMatch(
      /sendCopyrightNotice\(deps\.mail\(\), \{[\s\S]*?kind: "strike"/,
    );
  });
});
