// Doble de prueba de @supabase/supabase-js para las tablas de TikTok. Solo tests.
// Simula una única fila de `social_connections` con la semántica que importa al refresh:
// cada UPDATE condicionado se aplica de forma ATÓMICA (evalúa filtros y muta en un único
// paso síncrono), igual que un UPDATE de Postgres.

type Row = Record<string, unknown>;
export type FakeOp = "select" | "lease" | "release" | "refresh-save";

export const fakeDb = {
  row: null as Row | null,
  /** Historial de operaciones ejecutadas. */
  ops: [] as FakeOp[],
  /** Error devuelto por Supabase en la operación indicada. */
  failOn: {} as Partial<Record<FakeOp, unknown>>,
  /** Excepción lanzada (p. ej. fallo de red) en la operación indicada. */
  throwOn: {} as Partial<Record<FakeOp, unknown>>,
  /** Nº de veces que fallará `refresh-save` antes de funcionar. */
  refreshSaveFailures: 0,
  /** Se ejecuta justo antes de aplicar la operación (simula otra petición). */
  before: {} as Partial<Record<FakeOp, () => void>>,
};

export function resetFakeDb(): void {
  fakeDb.row = null;
  fakeDb.ops = [];
  fakeDb.failOn = {};
  fakeDb.throwOn = {};
  fakeDb.refreshSaveFailures = 0;
  fakeDb.before = {};
}

export function countOps(op: FakeOp): number {
  return fakeDb.ops.filter((o) => o === op).length;
}

function matchesOr(row: Row, expression: string): boolean {
  return expression.split(",").some((clause) => {
    const [column, operator, ...rest] = clause.split(".");
    const value = rest.join(".");
    const current = row[column];
    if (operator === "is" && value === "null")
      return current === null || current === undefined;
    if (operator === "lt") {
      return typeof current === "string" && Date.parse(current) < Date.parse(value);
    }
    return false;
  });
}

function classify(values: Row): FakeOp {
  if (values.refresh_lock_until && values.refresh_lock_until !== null) return "lease";
  return "access_token" in values ? "refresh-save" : "release";
}

class UpdateBuilder implements PromiseLike<{ data: Row[] | null; error: unknown }> {
  private filters: [string, unknown][] = [];
  private orExpression: string | undefined;
  private wantsRows = false;

  constructor(private values: Row) {}

  eq(column: string, value: unknown) {
    this.filters.push([column, value]);
    return this;
  }

  or(expression: string) {
    this.orExpression = expression;
    return this;
  }

  select() {
    this.wantsRows = true;
    return this;
  }

  then<T1, T2>(
    onfulfilled?:
      ((value: { data: Row[] | null; error: unknown }) => T1 | PromiseLike<T1>) | null,
    onrejected?: ((reason: unknown) => T2 | PromiseLike<T2>) | null,
  ): PromiseLike<T1 | T2> {
    return this.run().then(onfulfilled, onrejected);
  }

  private async run(): Promise<{ data: Row[] | null; error: unknown }> {
    const op = classify(this.values);
    // Cede el turno: permite que otras peticiones concurrentes se intercalen.
    await Promise.resolve();
    if (fakeDb.throwOn[op]) throw fakeDb.throwOn[op];
    fakeDb.before[op]?.();
    fakeDb.ops.push(op);
    if (fakeDb.failOn[op]) return { data: null, error: fakeDb.failOn[op] };
    if (op === "refresh-save" && fakeDb.refreshSaveFailures > 0) {
      fakeDb.refreshSaveFailures -= 1;
      return { data: null, error: { code: "08006", message: "connection failure" } };
    }

    const row = fakeDb.row;
    const matches =
      row !== null &&
      this.filters.every(([column, value]) => row[column] === value) &&
      (this.orExpression === undefined || matchesOr(row, this.orExpression));
    if (!matches || !row) return { data: this.wantsRows ? [] : null, error: null };

    Object.assign(row, this.values);
    return { data: this.wantsRows ? [{ provider: row.provider }] : null, error: null };
  }
}

function selectBuilder() {
  return {
    eq: () => ({
      maybeSingle: async () => {
        await Promise.resolve();
        if (fakeDb.throwOn.select) throw fakeDb.throwOn.select;
        fakeDb.before.select?.();
        fakeDb.ops.push("select");
        if (fakeDb.failOn.select) return { data: null, error: fakeDb.failOn.select };
        return { data: fakeDb.row ? { ...fakeDb.row } : null, error: null };
      },
    }),
  };
}

export function fakeCreateClient() {
  return {
    from: () => ({
      select: () => selectBuilder(),
      update: (values: Row) => new UpdateBuilder(values),
    }),
  };
}
