import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import CommunityPostEditorGate from "./CommunityPostEditorGate";

// R5-F: el editor de Community (crear y editar) no se monta hasta que el servidor confirma que no hay
// restricción de publicación vigente. El formulario real se sustituye por un marcador: aquí se prueba
// la compuerta (carga, error, restricción, desbloqueo), no el formulario (ya cubierto por sus tests).

const fakes = vi.hoisted(() => ({
  fetchRestriction: vi.fn(),
  userId: "user-1" as string | null,
}));

vi.mock("@/lib/community-client", async () => ({
  ...(await vi.importActual("@/lib/community-client")),
  fetchAuthorRestriction: fakes.fetchRestriction,
}));
vi.mock("@/lib/auth-context", () => ({
  useAuth: () => ({ user: fakes.userId ? { id: fakes.userId } : null }),
}));
vi.mock("./CommunityPostEditorForm", () => ({
  default: (props: { initialPost: unknown }) => (
    <form data-testid="editor-form" data-edit={props.initialPost ? "yes" : "no"}>
      <input type="file" aria-label="Añadir fotos o videos" />
    </form>
  ),
}));

const RESTRICTION = {
  level: 2 as const,
  permanent: false,
  endsAt: "2099-11-01T00:00:00+00:00",
  reason: "Spam repetido",
};

function renderGate(initialPost: unknown = null) {
  const onCancel = vi.fn();
  render(
    <CommunityPostEditorGate
      initialPost={initialPost as never}
      onSaved={() => {}}
      onCancel={onCancel}
    />,
  );
  return { onCancel };
}

beforeEach(() => {
  cleanup();
  vi.resetAllMocks();
  fakes.userId = "user-1";
});

describe("CommunityPostEditorGate", () => {
  it("sin restricción confirmada: abre el editor de creación y el de edición", async () => {
    fakes.fetchRestriction.mockResolvedValue(null);
    renderGate(null);
    const create = await screen.findByTestId("editor-form");
    expect(create).toHaveAttribute("data-edit", "no");
    cleanup();
    renderGate({ id: "p1" });
    expect(await screen.findByTestId("editor-form")).toHaveAttribute("data-edit", "yes");
  });

  it("mientras carga: ni formulario ni selector de archivos", () => {
    fakes.fetchRestriction.mockReturnValue(new Promise(() => {}));
    renderGate();
    expect(screen.getByRole("status")).toHaveTextContent("Comprobando");
    expect(screen.queryByTestId("editor-form")).toBeNull();
    expect(screen.queryByLabelText("Añadir fotos o videos")).toBeNull();
  });

  it("con restricción: aviso (nivel, plazo, motivo) y NINGÚN formulario ni selector de archivos", async () => {
    fakes.fetchRestriction.mockResolvedValue(RESTRICTION);
    const { onCancel } = renderGate({ id: "p1" });
    const notice = await screen.findByTestId("restriction-notice");
    expect(notice).toHaveTextContent("Has recibido tu segundo strike.");
    expect(screen.getByTestId("restriction-warning")).toHaveTextContent(
      "Última advertencia",
    );
    expect(notice).toHaveTextContent("Spam repetido");
    expect(notice).toHaveTextContent("No puedes crear ni editar publicaciones hasta");
    expect(notice).toHaveTextContent("eliminando tus propias publicaciones");
    expect(screen.queryByTestId("editor-form")).toBeNull();
    expect(screen.queryByLabelText("Añadir fotos o videos")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Cerrar" }));
    expect(onCancel).toHaveBeenCalled();
  });

  it("restricción permanente: se explica como permanente", async () => {
    fakes.fetchRestriction.mockResolvedValue({
      level: 3,
      permanent: true,
      endsAt: null,
      reason: "Reincidencia",
    });
    renderGate();
    expect(await screen.findByTestId("restriction-notice")).toHaveTextContent(
      "de forma permanente",
    );
  });

  it("error de la consulta: mensaje y reintento, el editor NO se abre; al reintentar con éxito se abre", async () => {
    fakes.fetchRestriction.mockRejectedValueOnce(new Error("red"));
    fakes.fetchRestriction.mockResolvedValueOnce(null);
    renderGate();
    expect(await screen.findByRole("alert")).toHaveTextContent("No pudimos comprobar");
    expect(screen.queryByTestId("editor-form")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Reintentar" }));
    expect(await screen.findByTestId("editor-form")).toBeInTheDocument();
    expect(fakes.fetchRestriction).toHaveBeenCalledTimes(2);
  });

  it("error seguido de restricción real: tras reintentar se muestra el aviso, nunca el editor", async () => {
    fakes.fetchRestriction.mockRejectedValueOnce(new Error("503"));
    fakes.fetchRestriction.mockResolvedValueOnce(RESTRICTION);
    renderGate();
    fireEvent.click(await screen.findByRole("button", { name: "Reintentar" }));
    expect(await screen.findByTestId("restriction-notice")).toBeInTheDocument();
    expect(screen.queryByTestId("editor-form")).toBeNull();
  });

  it("revocada o expirada: una nueva apertura consulta de nuevo y desbloquea (sin caché)", async () => {
    fakes.fetchRestriction.mockResolvedValueOnce(RESTRICTION);
    renderGate();
    expect(await screen.findByTestId("restriction-notice")).toBeInTheDocument();
    cleanup();
    fakes.fetchRestriction.mockResolvedValueOnce(null);
    renderGate();
    expect(await screen.findByTestId("editor-form")).toBeInTheDocument();
    expect(fakes.fetchRestriction).toHaveBeenCalledTimes(2);
  });

  it("una respuesta antigua (de un intento anterior) no desbloquea ni bloquea el editor", async () => {
    let resolveFirst!: (v: unknown) => void;
    fakes.fetchRestriction.mockReturnValueOnce(
      new Promise((r) => {
        resolveFirst = r;
      }),
    );
    fakes.fetchRestriction.mockRejectedValueOnce(new Error("x"));
    const view = render(
      <CommunityPostEditorGate
        initialPost={null}
        onSaved={() => {}}
        onCancel={() => {}}
      />,
    );
    // cambia la sesión mientras la primera consulta sigue en vuelo
    fakes.userId = "user-2";
    view.rerender(
      <CommunityPostEditorGate
        initialPost={null}
        onSaved={() => {}}
        onCancel={() => {}}
      />,
    );
    await screen.findByRole("alert"); // la segunda consulta (usuario nuevo) falló
    resolveFirst(null); // la primera llega tarde diciendo «sin restricción»
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByTestId("editor-form")).toBeNull();
    expect(screen.getByRole("alert")).toBeInTheDocument();
  });

  it("al desmontar con la consulta en vuelo no se actualiza nada ni se abre el editor", async () => {
    let resolveFetch!: (v: unknown) => void;
    fakes.fetchRestriction.mockReturnValue(
      new Promise((r) => {
        resolveFetch = r;
      }),
    );
    const view = render(
      <CommunityPostEditorGate
        initialPost={null}
        onSaved={() => {}}
        onCancel={() => {}}
      />,
    );
    view.unmount();
    resolveFetch(null);
    await waitFor(() => expect(fakes.fetchRestriction).toHaveBeenCalledTimes(1));
    expect(screen.queryByTestId("editor-form")).toBeNull();
  });
});

describe("rutas alternativas al editor", () => {
  function sources(dir: string): string[] {
    return readdirSync(dir).flatMap((name) => {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) return sources(full);
      return /\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name) ? [full] : [];
    });
  }

  it("el formulario solo se monta desde la compuerta: ningún otro módulo lo importa", () => {
    const importers = sources("src")
      .filter((file) => !file.endsWith("CommunityPostEditorForm.tsx"))
      .filter((file) =>
        /from\s+["'][^"']*CommunityPostEditorForm["']/.test(readFileSync(file, "utf8")),
      )
      .map((file) => file.replace(/\\/g, "/"));
    expect(importers).toEqual(["src/components/community/CommunityPostEditorGate.tsx"]);
  });

  it("el diálogo (perfil propio) usa la compuerta", () => {
    const dialog = readFileSync(
      "src/components/community/CommunityPostEditorDialog.tsx",
      "utf8",
    );
    expect(dialog).toMatch(/<CommunityPostEditorGate/);
    expect(dialog).not.toMatch(/<CommunityPostEditorForm/);
  });
});
