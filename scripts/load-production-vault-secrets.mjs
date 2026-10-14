#!/usr/bin/env node
// Carga en el Vault de Supabase PRODUCTION los 4 secretos que leen los ticks SQL (nunca imprime valores, no sobrescribe).
//   media_gc_shared_secret / media_gc_endpoint_url            → community-media-purge-tick (ya programado)
//   account_deletion_shared_secret / account_deletion_endpoint_url → account_deletion_tick (NO programado)
// Uso (PowerShell, con psql en PATH):
//   node scripts/load-production-vault-secrets.mjs --conn C:\Users\Edwin\upmina-backups\prod.conn --secrets C:\Users\Edwin\upmina-secrets\prod-20261014
// Aborta si el usuario/host de --conn no son Production, si algún secreto ya existe o si falta un valor.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const REF = "dmtuvzfdaectvqczwfhx";
const arg = (n) => process.argv[process.argv.indexOf(n) + 1];
const connFile = arg("--conn");
const secretsDir = arg("--secrets");
if (!connFile || !secretsDir) {
  console.error(
    "Uso: node scripts/load-production-vault-secrets.mjs --conn <prod.conn> --secrets <carpeta>",
  );
  process.exit(2);
}
const conn = readFileSync(connFile, "utf8").trim();
const m = conn.match(/^postgres(?:ql)?:\/\/([^:@/]+):([^@]+)@([^:/]+):(\d+)\/([^?\s]+)/);
if (!m) throw new Error("Formato de conexión no reconocido");
const [, user, pw, host, port, db] = m;
if (
  user !== `postgres.${REF}` ||
  !host.endsWith(".pooler.supabase.com") ||
  conn.includes("rkqeqbqwdswhpzwqptac")
)
  throw new Error("El destino no es Production. Abortado.");
const env = Object.fromEntries(
  readFileSync(join(secretsDir, "production-secrets.env"), "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]),
);
const SECRETS = [
  ["media_gc_shared_secret", env.MEDIA_GC_SHARED_SECRET],
  ["media_gc_endpoint_url", "https://upminaa-web.com/api/media/gc"],
  ["account_deletion_shared_secret", env.ACCOUNT_DELETION_SHARED_SECRET],
  [
    "account_deletion_endpoint_url",
    "https://upminaa-web.com/api/admin/account-deletion-run",
  ],
];
for (const [n, v] of SECRETS)
  if (!v || /['\\]/.test(v)) throw new Error(`Valor no válido para ${n}`);
if (SECRETS[0][1].length < 32 || SECRETS[2][1].length < 32)
  throw new Error("Secreto demasiado corto");
const penv = {
  ...process.env,
  PGHOST: host,
  PGPORT: port,
  PGUSER: user,
  PGPASSWORD: pw,
  PGDATABASE: db,
  PGSSLMODE: "require",
};
const psql = (sql) => {
  const r = spawnSync("psql", ["-X", "-A", "-t", "-v", "ON_ERROR_STOP=1"], {
    input: sql,
    env: penv,
    encoding: "utf8",
  });
  return {
    code: r.status,
    out: ((r.stdout ?? "") + (r.stderr ?? "")).split(pw).join("***"),
  };
};
const names = SECRETS.map(([n]) => `'${n}'`).join(",");
const pre = psql(`select count(*) from vault.secrets where name in (${names});`);
if (pre.code !== 0 || pre.out.trim() !== "0") {
  console.log(
    "ABORTA: ya existen secretos o falló la comprobación previa:",
    pre.out.trim().slice(0, 80),
  );
  process.exit(1);
}
const ins = psql(
  `begin;\n${SECRETS.map(([n, v]) => `select 1 from vault.create_secret('${v}', '${n}');`).join("\n")}\ncommit;`,
);
console.log(
  "insert exit:",
  ins.code,
  ins.code === 0 ? "" : ins.out.replace(/'[^']{20,}'/g, "'***'").slice(0, 200),
);
const sums = psql(
  `select name||'|'||encode(extensions.digest(decrypted_secret,'sha256'),'hex')||'|'||length(decrypted_secret) from vault.decrypted_secrets where name in (${names}) order by name;`,
);
for (const line of sums.out.trim().split("\n").filter(Boolean)) {
  const [n, h, len] = line.split("|");
  const want = SECRETS.find(([k]) => k === n)?.[1] ?? "";
  console.log(
    `${n}: len=${len} coincide_con_fuente=${createHash("sha256").update(want).digest("hex") === h}`,
  );
}
console.log(
  "total secretos en Vault:",
  psql("select count(*) from vault.secrets;").out.trim(),
);
