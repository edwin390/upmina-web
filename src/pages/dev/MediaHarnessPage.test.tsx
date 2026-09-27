import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { QueryClientProvider } from "@tanstack/react-query";
import { testQueryClient } from "@/test/query-client";
import MediaHarnessPage from "./MediaHarnessPage";

// Arnés de desarrollo (Fase 9I-2C): un 403 step_up_required real (MFA vencido con el arnés ya
// abierto) debe navegar al flujo de MFA existente (9G-3) con un returnTo seguro, NUNCA mostrar el
// string crudo de una clave de traducción, y NUNCA reintentar la subida por su cuenta. useAuth y
// GET /api/admin/access se mockean (ya cubiertos en profundidad en sus propios tests); aquí solo
// importa la orquestación de ESTE componente.

const authFakes = vi.hoisted(() => ({
  session: { access_token: "at-harness", user: { id: "admin-1" } } as {
    access_token: string;
    user: { id: string };
  } | null,
}));

vi.mock("@/lib/auth-context", () => ({
  useAuth: () => ({
    session: authFakes.session,
    user: authFakes.session?.user ?? null,
    loading: false,
    signOut: vi.fn(),
  }),
}));

vi.mock("@/lib/supabase", () => ({
  supabase: {
    auth: {
      async getSession() {
        return { data: { session: authFakes.session } };
      },
    },
  },
}));

const reserveMediaUploadMock = vi.fn();
const completeMediaUploadMock = vi.fn();
const uploadWithProgressMock = vi.fn();
vi.mock("@/lib/media-client", async () => {
  const actual =
    await vi.importActual<typeof import("@/lib/media-client")>("@/lib/media-client");
  return {
    ...actual,
    reserveMediaUpload: (...args: unknown[]) => reserveMediaUploadMock(...args),
    completeMediaUpload: (...args: unknown[]) => completeMediaUploadMock(...args),
    uploadWithProgress: (...args: unknown[]) => uploadWithProgressMock(...args),
  };
});

vi.mock("@/lib/media-transport", () => ({
  prepareUploadBlob: vi.fn(async (file: File) => ({
    blob: file,
    mime: file.type,
    bytes: file.size,
    strategy: "original",
    width: null,
    height: null,
  })),
}));

function fakeFile(name: string, bytes: number, mime = "image/jpeg"): File {
  return new File([new Uint8Array(bytes)], name, { type: mime });
}

function MfaProbe() {
  const location = useLocation();
  return <p data-testid="mfa">{location.pathname + location.search}</p>;
}

function tree() {
  return (
    <QueryClientProvider client={testQueryClient}>
      <MemoryRouter initialEntries={["/dev/media-harness"]}>
        <Routes>
          <Route path="/dev/media-harness" element={<MediaHarnessPage />} />
          <Route path="/admin/mfa" element={<MfaProbe />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>
  );
}

async function selectFile(file: File) {
  await screen.findByRole("heading");
  const input = document.querySelector('input[type="file"]') as HTMLInputElement;
  await act(async () => {
    Object.defineProperty(input, "files", { value: [file], configurable: true });
    fireEvent.change(input);
  });
}

beforeEach(() => {
  testQueryClient.clear();
  authFakes.session = { access_token: "at-harness", user: { id: "admin-1" } };
  reserveMediaUploadMock.mockReset();
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      if (url === "/api/admin/access") {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            role: "admin",
            capabilities: ["cosplay_admin"],
            mfa: { recent: true },
          }),
        };
      }
      throw new Error(`fetch inesperado a ${url}`);
    }),
  );
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("MediaHarnessPage — step_up_required real", () => {
  it("navega a /admin/mfa?returnTo=/dev/media-harness, nunca muestra la clave cruda de traducción", async () => {
    const { MediaClientError } = await import("@/lib/media-client");
    reserveMediaUploadMock.mockRejectedValue(
      new MediaClientError("No autorizado", 403, "step_up_required", "step_up_required"),
    );

    render(tree());
    await selectFile(fakeFile("foto.jpg", 1000));

    expect(await screen.findByTestId("mfa")).toHaveTextContent(
      "/admin/mfa?returnTo=/dev/media-harness",
    );
    // La clave cruda ("media.errors.step_up_required" o "errors.step_up_required") nunca debe
    // llegar a pintarse, ni siquiera brevemente antes de navegar.
    expect(document.body.textContent).not.toMatch(/errors\.step_up_required/);
    expect(document.body.textContent).not.toMatch(/media\.errors/);
  });

  it("un 403 genérico (sin capacidad) NUNCA navega a MFA — se queda como error normal en el arnés", async () => {
    const { MediaClientError } = await import("@/lib/media-client");
    reserveMediaUploadMock.mockRejectedValue(
      new MediaClientError("No autorizado", 403, undefined, "forbidden"),
    );

    render(tree());
    await selectFile(fakeFile("foto.jpg", 1000));

    await screen.findByRole("alert");
    expect(screen.queryByTestId("mfa")).toBeNull();
  });

  it("tras volver de MFA (remount), la cola queda vacía — nunca reintenta la subida por su cuenta", async () => {
    const { MediaClientError } = await import("@/lib/media-client");
    reserveMediaUploadMock.mockRejectedValue(
      new MediaClientError("No autorizado", 403, "step_up_required", "step_up_required"),
    );
    render(tree());
    await selectFile(fakeFile("foto.jpg", 1000));
    await screen.findByTestId("mfa");

    // reserveMediaUpload solo se llamó UNA vez (la selección original) — nada la volvió a llamar.
    expect(reserveMediaUploadMock).toHaveBeenCalledTimes(1);
  });
});

describe("MediaHarnessPage — camino feliz muestra las etiquetas de diagnóstico", () => {
  it("cada variante lista su ancho nominal, dimensiones reales y tamaño", async () => {
    reserveMediaUploadMock.mockResolvedValue({
      assetId: "asset-ok",
      mode: "single",
      uploadUrl: "https://r2.test/put",
      expiresInSeconds: 900,
    });
    uploadWithProgressMock.mockResolvedValue({ etag: '"e"' });
    completeMediaUploadMock.mockResolvedValue({
      assetId: "asset-ok",
      status: "ready",
      variants: [
        {
          variant: 480,
          width: 360,
          height: 480,
          bytes: 12680,
          url: "https://pub.test/w480.webp",
        },
      ],
    });

    render(tree());
    await selectFile(fakeFile("foto.jpg", 1000));

    expect(await screen.findByText("480 · 360×480 · 12 KB")).toBeInTheDocument();
  });
});
