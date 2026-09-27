// Doble de prueba de @supabase/supabase-js para public.public_content_snapshots. Solo tests.
// Simula una tabla con clave primaria `resource`: select por resource, upsert (sobrescribe la fila
// completa, como ON CONFLICT DO UPDATE) y delete por lista de recursos, además de los CHECK de la
// migración que un llamador podría rozar. NO es un emulador de Supabase: no prueba el motor real
// (eso se verificó aplicando la migración al proyecto desechable).
//
// Cada operación cede un turno antes de aplicarse (otra petición puede intercalarse) y admite
// fallos inyectados: un error devuelto (`failOn`), una excepción (`throwOn`) o una operación que no
// termina nunca salvo que se aborte su señal (`hang`, para el plazo).

type Row = Record<string, unknown>;
export type SnapshotOp = "select" | "upsert" | "delete";

export const SNAPSHOT_TABLE = "public_content_snapshots";

const ALLOWED_RESOURCES = [
  "twitch-clips",
  "twitch-latest-video",
  "youtube-latest",
  "youtube-videos",
  "youtube-shorts",
  "instagram-feed",
  "instagram-profile",
  "tiktok-videos",
];

export const snapshotDb = {
  /** Filas por `resource` (PK). Los tests las siembran directamente (p. ej. filas corruptas). */
  rows: new Map<string, Row>(),
  /** Operaciones aplicadas, en orden. */
  ops: [] as { op: SnapshotOp; resource?: string; resources?: string[] }[],
  /** Error devuelto por Supabase (no una excepción) en la operación indicada. */
  failOn: {} as Partial<Record<SnapshotOp, unknown>>,
  /** Excepción lanzada por el cliente en la operación indicada. */
  throwOn: {} as Partial<Record<SnapshotOp, unknown>>,
  /** La operación nunca termina salvo que se aborte su señal. */
  hang: {} as Partial<Record<SnapshotOp, boolean>>,
  /** Se ejecuta justo antes de aplicar la operación (simula otra petición). */
  before: {} as Partial<Record<SnapshotOp, () => void>>,
  /** Nº de clientes creados con createClient (comprueba la configuración). */
  clientsCreated: 0,
  /** Última URL/clave con la que se creó un cliente. */
  lastClientArgs: undefined as unknown[] | undefined,
};

export function resetSnapshotDb(): void {
  snapshotDb.rows = new Map();
  snapshotDb.ops = [];
  snapshotDb.failOn = {};
  snapshotDb.throwOn = {};
  snapshotDb.hang = {};
  snapshotDb.before = {};
  snapshotDb.clientsCreated = 0;
  snapshotDb.lastClientArgs = undefined;
}

export function countSnapshotOps(op: SnapshotOp): number {
  return snapshotDb.ops.filter((o) => o.op === op).length;
}

/** CHECK de la migración que puede violar un upsert (código 23514 de Postgres). */
function violatesChecks(row: Row): boolean {
  if (typeof row.resource !== "string" || !ALLOWED_RESOURCES.includes(row.resource)) {
    return true;
  }
  if (typeof row.source_id !== "string") return true;
  if (row.source_id.length < 1 || row.source_id.length > 200) return true;
  const payload = row.payload;
  if (typeof payload !== "object" || payload === null) return true;
  return JSON.stringify(payload).length > 262144;
}

/** Ejecuta `apply` de forma asíncrona respetando fallos inyectados y la señal de aborto. */
function run<T>(
  op: SnapshotOp,
  signal: AbortSignal | undefined,
  apply: () => T,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(new DOMException("Aborted", "AbortError"));
    if (signal?.aborted) return abort();
    signal?.addEventListener("abort", abort, { once: true });
    if (snapshotDb.hang[op]) return;
    void Promise.resolve().then(() => {
      try {
        snapshotDb.before[op]?.();
        if (snapshotDb.throwOn[op]) throw snapshotDb.throwOn[op];
        resolve(apply());
      } catch (err) {
        reject(err);
      }
    });
  });
}

class Builder<T> implements PromiseLike<T> {
  protected signal: AbortSignal | undefined;

  constructor(
    private readonly op: SnapshotOp,
    private readonly apply: () => T,
  ) {}

  abortSignal(signal: AbortSignal) {
    this.signal = signal;
    return this;
  }

  then<R1 = T, R2 = never>(
    onfulfilled?: ((value: T) => R1 | PromiseLike<R1>) | null,
    onrejected?: ((reason: unknown) => R2 | PromiseLike<R2>) | null,
  ): PromiseLike<R1 | R2> {
    return run(this.op, this.signal, this.apply).then(onfulfilled, onrejected);
  }
}

function tableApi() {
  return {
    select() {
      const filters: [string, unknown][] = [];
      const builder = {
        eq(column: string, value: unknown) {
          filters.push([column, value]);
          return builder;
        },
        abortSignal(signal: AbortSignal) {
          signalRef.current = signal;
          return builder;
        },
        maybeSingle() {
          const resource = filters.find(([c]) => c === "resource")?.[1] as string;
          return run("select", signalRef.current, () => {
            snapshotDb.ops.push({ op: "select", resource });
            if (snapshotDb.failOn.select) {
              return { data: null, error: snapshotDb.failOn.select };
            }
            const row = snapshotDb.rows.get(resource);
            return { data: row ? { ...row } : null, error: null };
          });
        },
      };
      const signalRef: { current: AbortSignal | undefined } = { current: undefined };
      return builder;
    },
    upsert(row: Row, options: { onConflict?: string } = {}) {
      return new Builder("upsert", () => {
        const key = String(row[options.onConflict ?? "resource"]);
        snapshotDb.ops.push({ op: "upsert", resource: key });
        if (snapshotDb.failOn.upsert) return { error: snapshotDb.failOn.upsert };
        if (violatesChecks(row)) return { error: { code: "23514" } };
        // ON CONFLICT DO UPDATE: la fila queda con los valores enviados.
        snapshotDb.rows.set(key, { ...row });
        return { error: null };
      });
    },
    delete() {
      return {
        in(column: string, values: string[]) {
          return new Builder("delete", () => {
            snapshotDb.ops.push({ op: "delete", resources: [...values] });
            if (snapshotDb.failOn.delete) return { error: snapshotDb.failOn.delete };
            for (const key of [...snapshotDb.rows.keys()]) {
              if (column === "resource" && values.includes(key))
                snapshotDb.rows.delete(key);
            }
            return { error: null };
          });
        },
      };
    },
  };
}

export function fakeCreateClient(...args: unknown[]) {
  snapshotDb.clientsCreated += 1;
  snapshotDb.lastClientArgs = args;
  return {
    from(table: string) {
      // Cualquier otra tabla sería un error del módulo bajo prueba.
      if (table !== SNAPSHOT_TABLE) throw new Error(`tabla inesperada: ${table}`);
      return tableApi();
    },
  };
}
