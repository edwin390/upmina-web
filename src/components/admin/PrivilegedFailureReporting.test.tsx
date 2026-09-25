import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { PrivilegedFailureContext } from "@/hooks/privileged-failure";
import type { PrivilegedFailure } from "@/lib/privileged-response";
import SocialConnectionsSection from "./SocialConnectionsSection";
import TeamInvitationsSection from "./TeamInvitationsSection";
import TeamMembersSection from "./TeamMembersSection";

// Integración de las secciones privilegiadas con el canal común de fallos (Fase 9G-3): TODAS
// clasifican igual el rechazo del servidor y lo comunican al contenedor (/admin):
//   401 → "unauthenticated" · 403 + step_up_required → "step_up_required" · 403 genérico →
//   "forbidden" (nunca MFA). Un rechazo NUNCA reproduce la petición pendiente ni ejecuta una
//   mutación automáticamente. Sin proveedor, las secciones se comportan como antes.

const auth = vi.hoisted(() => ({ session: null as null | { access_token: string } }));

vi.mock("@/lib/supabase", () => ({
  supabase: { auth: { getSession: async () => ({ data: { session: auth.session } }) } },
}));

const fetchMock = vi.fn();
const res = (status: number, body: unknown = {}) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
});
const STEP_UP = () => res(403, { error: "No autorizado", code: "step_up_required" });
const FORBIDDEN = () => res(403, { error: "No autorizado" });

const onFailure = vi.fn<(failure: PrivilegedFailure) => void>();

beforeEach(() => {
  auth.session = { access_token: "at-sintetico" };
  fetchMock.mockReset();
  onFailure.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function withHandler(node: React.ReactNode) {
  return render(
    <PrivilegedFailureContext.Provider value={onFailure}>
      {node}
    </PrivilegedFailureContext.Provider>,
  );
}

const SECTIONS: [string, () => React.ReactNode, string][] = [
  [
    "Redes sociales",
    () => <SocialConnectionsSection navigate={() => undefined} />,
    "social-status",
  ],
  ["Invitaciones del equipo", () => <TeamInvitationsSection />, "team-invitations"],
  ["Miembros del equipo", () => <TeamMembersSection />, "team-members"],
];

describe.each(SECTIONS)("%s — carga inicial", (_name, section, endpoint) => {
  it.each([
    ["401", () => res(401), "unauthenticated"],
    ["403 genérico", FORBIDDEN, "forbidden"],
    ["403 step_up_required", STEP_UP, "step_up_required"],
  ] as const)("%s → informa %s una vez", async (_n, response, expected) => {
    fetchMock.mockImplementation(async () => response());
    withHandler(section());

    await waitFor(() => expect(onFailure).toHaveBeenCalledWith(expected));
    expect(onFailure).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls.every(([url]) => String(url).endsWith(endpoint))).toBe(
      true,
    );
  });

  it.each([
    ["500", () => res(500)],
    ["404", () => res(404)],
  ])("%s no es un rechazo de autorización → no se informa", async (_n, response) => {
    fetchMock.mockImplementation(async () => response());
    withHandler(section());

    await screen.findByRole("alert");
    await new Promise((r) => setTimeout(r, 20));
    expect(onFailure).not.toHaveBeenCalled();
  });

  it("un 403 NO reproduce la petición ni lanza otra distinta (sin reintentos automáticos)", async () => {
    fetchMock.mockImplementation(async () => STEP_UP());
    withHandler(section());

    await waitFor(() => expect(onFailure).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 30));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    for (const [, init] of fetchMock.mock.calls) {
      expect((init as { method?: string } | undefined)?.method ?? "GET").toBe("GET");
    }
  });

  it("sin proveedor el mismo rechazo no rompe nada (manejador no-op)", async () => {
    fetchMock.mockImplementation(async () => STEP_UP());
    render(<>{section()}</>);

    expect(await screen.findByRole("alert")).toBeInTheDocument();
    expect(onFailure).not.toHaveBeenCalled();
  });
});

describe("Invitaciones — acción de crear", () => {
  it("step_up_required en el POST → se informa UNA vez, el POST no se reproduce y no hay segundo request", async () => {
    fetchMock.mockImplementation(async (url: string, init?: { method?: string }) => {
      if (String(url).endsWith("team-invitations") && init?.method === "POST")
        return STEP_UP();
      return res(200, { invitations: [] });
    });
    withHandler(<TeamInvitationsSection />);

    fireEvent.click(await screen.findByRole("button", { name: "Crear invitación" }));

    await waitFor(() => expect(onFailure).toHaveBeenCalledWith("step_up_required"));
    await new Promise((r) => setTimeout(r, 30));
    const posts = fetchMock.mock.calls.filter(([, init]) => init?.method === "POST");
    expect(posts).toHaveLength(1);
    expect(onFailure).toHaveBeenCalledTimes(1);
  });

  it("403 genérico en el POST → 'forbidden' (nunca MFA)", async () => {
    fetchMock.mockImplementation(async (url: string, init?: { method?: string }) => {
      if (String(url).endsWith("team-invitations") && init?.method === "POST")
        return FORBIDDEN();
      return res(200, { invitations: [] });
    });
    withHandler(<TeamInvitationsSection />);

    fireEvent.click(await screen.findByRole("button", { name: "Crear invitación" }));

    await waitFor(() => expect(onFailure).toHaveBeenCalledWith("forbidden"));
    expect(onFailure).not.toHaveBeenCalledWith("step_up_required");
  });
});
