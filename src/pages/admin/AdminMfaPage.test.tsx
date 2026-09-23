import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";

// Fija /admin/mfa (Bloque 3B): AAL2 no crea enroll/challenge innecesarios, AAL1 con
// factor TOTP existente reutiliza ese factor, AAL1 sin factor permite enrolar, el QR/
// secret solo viven en memoria del componente, challenge/verify usan siempre el factor
// y challengeId correctos (nunca reutilizados), y los errores del proveedor nunca se
// muestran tal cual. useAuth se mockea (ya cubierto en profundidad por
// auth-context.test.tsx); AdminMfaPage.routing.test.tsx cubre la integración real con
// AuthProvider + routing.

const authFakes = vi.hoisted(() => ({
  session: null as { user: { email: string } } | null,
  loading: false,
  signOutCalls: 0,
}));

vi.mock("@/lib/auth-context", () => ({
  useAuth: () => ({
    session: authFakes.session,
    user: authFakes.session?.user ?? null,
    loading: authFakes.loading,
    signOut: async () => {
      authFakes.signOutCalls++;
    },
  }),
}));

interface FakeFactor {
  id: string;
  factor_type: "totp";
  status: "verified" | "unverified";
}

const mfaFakes = vi.hoisted(() => ({
  aalResult: undefined as
    { data: { currentLevel: string } | null; error: unknown } | undefined,
  factorsResult: undefined as
    { data: { all: unknown[]; totp: FakeFactor[] } | null; error: unknown } | undefined,
  enrollResult: undefined as { data: unknown; error: unknown } | undefined,
  challengeResult: undefined as { data: unknown; error: unknown } | undefined,
  verifyResult: undefined as { data: unknown; error: unknown } | undefined,
  unenrollResult: undefined as { data: unknown; error: unknown } | undefined,
  calls: {
    getAAL: 0,
    listFactors: 0,
    enroll: [] as unknown[],
    challenge: [] as unknown[],
    verify: [] as unknown[],
    unenroll: [] as unknown[],
  },
}));

function resetMfaFakes() {
  mfaFakes.aalResult = undefined;
  mfaFakes.factorsResult = undefined;
  mfaFakes.enrollResult = undefined;
  mfaFakes.challengeResult = undefined;
  mfaFakes.verifyResult = undefined;
  mfaFakes.unenrollResult = undefined;
  mfaFakes.calls = {
    getAAL: 0,
    listFactors: 0,
    enroll: [],
    challenge: [],
    verify: [],
    unenroll: [],
  };
}

vi.mock("@/lib/supabase", () => ({
  supabase: {
    auth: {
      mfa: {
        async getAuthenticatorAssuranceLevel() {
          mfaFakes.calls.getAAL++;
          return mfaFakes.aalResult ?? { data: { currentLevel: "aal1" }, error: null };
        },
        async listFactors() {
          mfaFakes.calls.listFactors++;
          return mfaFakes.factorsResult ?? { data: { all: [], totp: [] }, error: null };
        },
        async enroll(params: unknown) {
          mfaFakes.calls.enroll.push(params);
          return (
            mfaFakes.enrollResult ?? { data: null, error: new Error("sin configurar") }
          );
        },
        async challenge(params: unknown) {
          mfaFakes.calls.challenge.push(params);
          return (
            mfaFakes.challengeResult ?? { data: null, error: new Error("sin configurar") }
          );
        },
        async verify(params: unknown) {
          mfaFakes.calls.verify.push(params);
          return (
            mfaFakes.verifyResult ?? { data: null, error: new Error("sin configurar") }
          );
        },
        async unenroll(params: unknown) {
          mfaFakes.calls.unenroll.push(params);
          return mfaFakes.unenrollResult ?? { data: { id: "irrelevante" }, error: null };
        },
      },
    },
  },
}));

import AdminMfaPage from "./AdminMfaPage";

function resetFakes() {
  authFakes.session = null;
  authFakes.loading = false;
  authFakes.signOutCalls = 0;
  resetMfaFakes();
}

function renderMfaPage() {
  return render(
    <MemoryRouter initialEntries={["/admin/mfa"]}>
      <Routes>
        <Route path="/admin/mfa" element={<AdminMfaPage />} />
        <Route path="/admin/login" element={<p>Login stub</p>} />
      </Routes>
    </MemoryRouter>,
  );
}

function authenticated() {
  authFakes.session = { user: { email: "admin@example.com" } };
}

function totpFactor(overrides: Partial<FakeFactor> = {}): FakeFactor {
  return { id: "factor-1", factor_type: "totp", status: "verified", ...overrides };
}

beforeEach(() => {
  resetFakes();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("AdminMfaPage — sin sesión", () => {
  it("no ejecuta ninguna operación MFA y ofrece volver a /admin/login", async () => {
    renderMfaPage();

    expect(
      await screen.findByRole("link", { name: /iniciar sesión/i }),
    ).toBeInTheDocument();
    expect(mfaFakes.calls.getAAL).toBe(0);
    expect(mfaFakes.calls.listFactors).toBe(0);
    expect(mfaFakes.calls.enroll).toHaveLength(0);
  });
});

describe("AdminMfaPage — sesión AAL2", () => {
  it("muestra la verificación completada, sin listFactors/enroll/challenge, y permite cerrar sesión", async () => {
    authenticated();
    mfaFakes.aalResult = { data: { currentLevel: "aal2" }, error: null };
    renderMfaPage();

    await screen.findByText(/verificación en dos pasos activa/i);

    expect(mfaFakes.calls.getAAL).toBe(1);
    expect(mfaFakes.calls.listFactors).toBe(0);
    expect(mfaFakes.calls.enroll).toHaveLength(0);
    expect(mfaFakes.calls.challenge).toHaveLength(0);

    fireEvent.click(screen.getByRole("button", { name: /cerrar sesión/i }));
    expect(authFakes.signOutCalls).toBe(1);
  });
});

describe("AdminMfaPage — sesión AAL1 con factor TOTP existente", () => {
  it("usa ese factor (no enrolla otro) y permite introducir el código", async () => {
    authenticated();
    mfaFakes.aalResult = { data: { currentLevel: "aal1" }, error: null };
    mfaFakes.factorsResult = { data: { all: [], totp: [totpFactor()] }, error: null };
    renderMfaPage();

    await screen.findByLabelText("Código de verificación");
    expect(mfaFakes.calls.enroll).toHaveLength(0);
    expect(screen.queryByAltText(/código qr/i)).not.toBeInTheDocument();
    // Un factor TOTP ya verificado JAMÁS se desenrola, ni siquiera implícitamente.
    expect(mfaFakes.calls.unenroll).toHaveLength(0);
  });

  it("challenge usa el factor correcto y verify recibe factor/challenge/código exactos", async () => {
    authenticated();
    mfaFakes.aalResult = { data: { currentLevel: "aal1" }, error: null };
    mfaFakes.factorsResult = {
      data: { all: [], totp: [totpFactor({ id: "factor-existente" })] },
      error: null,
    };
    mfaFakes.challengeResult = {
      data: { id: "challenge-1", type: "totp", expires_at: 0 },
      error: null,
    };
    mfaFakes.verifyResult = {
      data: {
        access_token: "at",
        refresh_token: "rt",
        expires_in: 3600,
        token_type: "bearer",
      },
      error: null,
    };
    renderMfaPage();

    const input = await screen.findByLabelText("Código de verificación");
    fireEvent.change(input, { target: { value: "123456" } });
    fireEvent.click(screen.getByRole("button", { name: /^verificar$/i }));

    await waitFor(() => expect(mfaFakes.calls.verify).toHaveLength(1));
    expect(mfaFakes.calls.challenge).toEqual([{ factorId: "factor-existente" }]);
    expect(mfaFakes.calls.verify).toEqual([
      { factorId: "factor-existente", challengeId: "challenge-1", code: "123456" },
    ]);
    // Reutilizado para challenge/verify, jamás desenrolado.
    expect(mfaFakes.calls.unenroll).toHaveLength(0);
  });

  it("verify exitoso vuelve a comprobar el AAL para confirmar el estado aal2", async () => {
    authenticated();
    mfaFakes.aalResult = { data: { currentLevel: "aal1" }, error: null };
    mfaFakes.factorsResult = { data: { all: [], totp: [totpFactor()] }, error: null };
    mfaFakes.challengeResult = {
      data: { id: "challenge-1", type: "totp", expires_at: 0 },
      error: null,
    };
    mfaFakes.verifyResult = {
      data: {
        access_token: "at",
        refresh_token: "rt",
        expires_in: 3600,
        token_type: "bearer",
      },
      error: null,
    };
    renderMfaPage();

    const input = await screen.findByLabelText("Código de verificación");
    fireEvent.change(input, { target: { value: "123456" } });
    expect(mfaFakes.calls.getAAL).toBe(1);

    // Tras el verify exitoso, la siguiente comprobación de AAL reporta aal2.
    mfaFakes.aalResult = { data: { currentLevel: "aal2" }, error: null };
    fireEvent.click(screen.getByRole("button", { name: /^verificar$/i }));

    await screen.findByText(/verificación en dos pasos activa/i);
    expect(mfaFakes.calls.getAAL).toBe(2);
  });

  it("código inválido/expirado muestra un mensaje seguro, nunca el texto del proveedor", async () => {
    authenticated();
    mfaFakes.aalResult = { data: { currentLevel: "aal1" }, error: null };
    mfaFakes.factorsResult = { data: { all: [], totp: [totpFactor()] }, error: null };
    mfaFakes.challengeResult = {
      data: { id: "challenge-1", type: "totp", expires_at: 0 },
      error: null,
    };
    mfaFakes.verifyResult = {
      data: null,
      error: Object.assign(new Error("Invalid TOTP code entered"), {
        code: "mfa_verification_failed",
      }),
    };
    renderMfaPage();

    const input = await screen.findByLabelText("Código de verificación");
    fireEvent.change(input, { target: { value: "000000" } });
    fireEvent.click(screen.getByRole("button", { name: /^verificar$/i }));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe("Código incorrecto o expirado.");
    expect(alert.textContent).not.toMatch(/Invalid TOTP/i);
  });

  it("fallo de challenge muestra un mensaje seguro y nunca llama a verify", async () => {
    authenticated();
    mfaFakes.aalResult = { data: { currentLevel: "aal1" }, error: null };
    mfaFakes.factorsResult = { data: { all: [], totp: [totpFactor()] }, error: null };
    mfaFakes.challengeResult = {
      data: null,
      error: Object.assign(new Error("factor not found: internal detail"), {
        code: "mfa_factor_not_found",
      }),
    };
    renderMfaPage();

    const input = await screen.findByLabelText("Código de verificación");
    fireEvent.change(input, { target: { value: "123456" } });
    fireEvent.click(screen.getByRole("button", { name: /^verificar$/i }));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe(
      "No se pudo iniciar la verificación. Inténtalo de nuevo.",
    );
    expect(alert.textContent).not.toMatch(/factor not found|internal detail/i);
    expect(mfaFakes.calls.verify).toHaveLength(0);
  });
});

describe("AdminMfaPage — sesión AAL1 sin factor TOTP", () => {
  it("permite iniciar el enrolamiento explícitamente", async () => {
    authenticated();
    mfaFakes.aalResult = { data: { currentLevel: "aal1" }, error: null };
    mfaFakes.factorsResult = { data: { all: [], totp: [] }, error: null };
    renderMfaPage();

    expect(
      await screen.findByRole("button", { name: /configurar autenticador/i }),
    ).toBeInTheDocument();
    expect(mfaFakes.calls.enroll).toHaveLength(0);
  });

  it("enroll muestra el QR/secret (solo en memoria) y permite verificar; no escribe en localStorage/sessionStorage", async () => {
    authenticated();
    mfaFakes.aalResult = { data: { currentLevel: "aal1" }, error: null };
    mfaFakes.factorsResult = { data: { all: [], totp: [] }, error: null };
    mfaFakes.enrollResult = {
      data: {
        id: "factor-nuevo",
        type: "totp",
        totp: {
          qr_code: "<svg>qr</svg>",
          secret: "SECRETO-TOTP",
          uri: "otpauth://totp/x",
        },
      },
      error: null,
    };
    const localStorageSpy = vi.spyOn(Storage.prototype, "setItem");
    renderMfaPage();

    fireEvent.click(
      await screen.findByRole("button", { name: /configurar autenticador/i }),
    );

    const qrImg = await screen.findByAltText(/código qr/i);
    expect(mfaFakes.calls.enroll).toEqual([{ factorType: "totp" }]);
    expect(screen.getByLabelText("Código de verificación")).toBeInTheDocument();
    // El secreto está oculto por defecto (input type="password"), nunca expuesto en texto plano sin acción explícita.
    expect(screen.getByLabelText("Clave manual")).toHaveAttribute("type", "password");
    expect(localStorageSpy).not.toHaveBeenCalled();
    // SVG crudo (no es una data URI ya completa): buildTotpQrImageSrc lo detecta y lo
    // encodea EXACTAMENTE una vez antes de anteponer el prefijo (ver src/lib/mfa-qr.ts).
    expect(qrImg).toHaveAttribute(
      "src",
      `data:image/svg+xml;utf-8,${encodeURIComponent("<svg>qr</svg>")}`,
    );
  });

  it("un qr_code SVG crudo con caracteres especiales (comillas, #, %) se encodea exactamente una vez", async () => {
    authenticated();
    mfaFakes.aalResult = { data: { currentLevel: "aal1" }, error: null };
    mfaFakes.factorsResult = { data: { all: [], totp: [] }, error: null };
    const rawQrCode = `<svg><text>"quoted" #hash %percent</text></svg>`;
    mfaFakes.enrollResult = {
      data: {
        id: "factor-nuevo",
        type: "totp",
        totp: { qr_code: rawQrCode, secret: "SECRETO-TOTP", uri: "otpauth://totp/x" },
      },
      error: null,
    };
    renderMfaPage();

    fireEvent.click(
      await screen.findByRole("button", { name: /configurar autenticador/i }),
    );

    const qrImg = await screen.findByAltText(/código qr/i);
    const src = qrImg.getAttribute("src") ?? "";
    expect(src).toBe(`data:image/svg+xml;utf-8,${encodeURIComponent(rawQrCode)}`);
    // El roundtrip reproduce EXACTAMENTE el SVG original: prueba de que es un solo encoding.
    expect(decodeURIComponent(src.slice("data:image/svg+xml;utf-8,".length))).toBe(
      rawQrCode,
    );
    // Doble encoding produciría %2522/%253C en vez de %22/%3C una sola vez.
    expect(src).not.toContain("%2522");
    expect(src).not.toContain("%253C");
  });

  it("un qr_code que ya llega como data URI completa se usa tal cual, sin anteponer otro prefijo", async () => {
    authenticated();
    mfaFakes.aalResult = { data: { currentLevel: "aal1" }, error: null };
    mfaFakes.factorsResult = { data: { all: [], totp: [] }, error: null };
    const completeDataUri = "data:image/svg+xml;utf-8,%3Csvg%3E%3C%2Fsvg%3E";
    mfaFakes.enrollResult = {
      data: {
        id: "factor-nuevo",
        type: "totp",
        totp: {
          qr_code: completeDataUri,
          secret: "SECRETO-TOTP",
          uri: "otpauth://totp/x",
        },
      },
      error: null,
    };
    renderMfaPage();

    fireEvent.click(
      await screen.findByRole("button", { name: /configurar autenticador/i }),
    );

    const qrImg = await screen.findByAltText(/código qr/i);
    expect(qrImg).toHaveAttribute("src", completeDataUri);
    // Nunca una data URI anidada (el bug real reportado: "data:...data:...").
    expect(qrImg.getAttribute("src")?.match(/data:/g)).toHaveLength(1);
  });

  it("fallo de enrolamiento muestra un mensaje seguro, sin exponer detalles del proveedor", async () => {
    authenticated();
    mfaFakes.aalResult = { data: { currentLevel: "aal1" }, error: null };
    mfaFakes.factorsResult = { data: { all: [], totp: [] }, error: null };
    mfaFakes.enrollResult = {
      data: null,
      error: Object.assign(new Error("too many factors: quota internal=5"), {
        code: "too_many_enrolled_mfa_factors",
      }),
    };
    renderMfaPage();

    fireEvent.click(
      await screen.findByRole("button", { name: /configurar autenticador/i }),
    );

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe(
      "No se pudo iniciar el enrolamiento. Inténtalo de nuevo.",
    );
    expect(alert.textContent).not.toMatch(/quota internal/i);
  });

  it("cancelar un enrolamiento incompleto elimina el factor sin verificar y vuelve a la pantalla anterior", async () => {
    authenticated();
    mfaFakes.aalResult = { data: { currentLevel: "aal1" }, error: null };
    mfaFakes.factorsResult = { data: { all: [], totp: [] }, error: null };
    mfaFakes.enrollResult = {
      data: {
        id: "factor-nuevo",
        type: "totp",
        totp: {
          qr_code: "<svg>qr</svg>",
          secret: "SECRETO-TOTP",
          uri: "otpauth://totp/x",
        },
      },
      error: null,
    };
    renderMfaPage();

    fireEvent.click(
      await screen.findByRole("button", { name: /configurar autenticador/i }),
    );
    await screen.findByAltText(/código qr/i);

    fireEvent.click(screen.getByRole("button", { name: /cancelar/i }));

    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: /configurar autenticador/i }),
      ).toBeInTheDocument(),
    );
    expect(mfaFakes.calls.unenroll).toEqual([{ factorId: "factor-nuevo" }]);
  });

  it("challenge/verify tras el enrolamiento usan el factor recién creado", async () => {
    authenticated();
    mfaFakes.aalResult = { data: { currentLevel: "aal1" }, error: null };
    mfaFakes.factorsResult = { data: { all: [], totp: [] }, error: null };
    mfaFakes.enrollResult = {
      data: {
        id: "factor-nuevo",
        type: "totp",
        totp: {
          qr_code: "<svg>qr</svg>",
          secret: "SECRETO-TOTP",
          uri: "otpauth://totp/x",
        },
      },
      error: null,
    };
    mfaFakes.challengeResult = {
      data: { id: "challenge-9", type: "totp", expires_at: 0 },
      error: null,
    };
    mfaFakes.verifyResult = {
      data: {
        access_token: "at",
        refresh_token: "rt",
        expires_in: 3600,
        token_type: "bearer",
      },
      error: null,
    };
    renderMfaPage();

    fireEvent.click(
      await screen.findByRole("button", { name: /configurar autenticador/i }),
    );
    await screen.findByAltText(/código qr/i);

    fireEvent.change(screen.getByLabelText("Código de verificación"), {
      target: { value: "654321" },
    });
    fireEvent.click(screen.getByRole("button", { name: /verificar y activar/i }));

    await waitFor(() => expect(mfaFakes.calls.verify).toHaveLength(1));
    expect(mfaFakes.calls.challenge).toEqual([{ factorId: "factor-nuevo" }]);
    expect(mfaFakes.calls.verify).toEqual([
      { factorId: "factor-nuevo", challengeId: "challenge-9", code: "654321" },
    ]);
  });
});

describe("AdminMfaPage — enrolamiento TOTP interrumpido (abandonado sin verificar)", () => {
  // `factorsResult.data.totp` (contrato real: ver AuthMFAListFactorsResponse en
  // @supabase/auth-js) NUNCA contiene factores unverified — solo aparecen en `data.all`.
  // Estos tests simulan justamente ese estado real: un factor TOTP unverified visible
  // únicamente en `all`, como quedaría tras abandonar /admin/mfa sin completar el código.
  function abandonedFactorsResult(id = "factor-abandonado") {
    return {
      data: { all: [totpFactor({ id, status: "unverified" })], totp: [] },
      error: null,
    };
  }

  it("se detecta correctamente y NO bloquea permanentemente: sigue ofreciendo 'Configurar autenticador'", async () => {
    authenticated();
    mfaFakes.aalResult = { data: { currentLevel: "aal1" }, error: null };
    mfaFakes.factorsResult = abandonedFactorsResult();
    renderMfaPage();

    expect(
      await screen.findByRole("button", { name: /configurar autenticador/i }),
    ).toBeInTheDocument();
    // La detección en sí (listFactors) nunca dispara unenroll/enroll automáticamente.
    expect(mfaFakes.calls.unenroll).toHaveLength(0);
    expect(mfaFakes.calls.enroll).toHaveLength(0);
  });

  it("al pulsar 'Configurar autenticador' limpia ÚNICAMENTE ese factor unverified (unenroll) y después enrolla uno nuevo limpio", async () => {
    authenticated();
    mfaFakes.aalResult = { data: { currentLevel: "aal1" }, error: null };
    mfaFakes.factorsResult = abandonedFactorsResult("factor-abandonado");
    mfaFakes.enrollResult = {
      data: {
        id: "factor-limpio",
        type: "totp",
        totp: {
          qr_code: "<svg>nuevo</svg>",
          secret: "SECRETO-NUEVO",
          uri: "otpauth://totp/y",
        },
      },
      error: null,
    };
    renderMfaPage();

    fireEvent.click(
      await screen.findByRole("button", { name: /configurar autenticador/i }),
    );

    await screen.findByAltText(/código qr/i);
    // Exactamente un unenroll (el factor abandonado) seguido de exactamente un enroll:
    // nunca un loop, nunca más de una limpieza por clic.
    expect(mfaFakes.calls.unenroll).toEqual([{ factorId: "factor-abandonado" }]);
    expect(mfaFakes.calls.enroll).toEqual([{ factorType: "totp" }]);
  });

  it("si la limpieza del factor abandonado falla, muestra un error seguro y NO intenta enrollar (sin loop)", async () => {
    authenticated();
    mfaFakes.aalResult = { data: { currentLevel: "aal1" }, error: null };
    mfaFakes.factorsResult = abandonedFactorsResult("factor-abandonado");
    mfaFakes.unenrollResult = {
      data: null,
      error: Object.assign(new Error("factor not found: internal detail"), {
        code: "mfa_factor_not_found",
      }),
    };
    renderMfaPage();

    fireEvent.click(
      await screen.findByRole("button", { name: /configurar autenticador/i }),
    );

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe(
      "No se pudo limpiar un enrolamiento anterior incompleto. Inténtalo de nuevo.",
    );
    expect(alert.textContent).not.toMatch(/factor not found|internal detail/i);
    expect(mfaFakes.calls.unenroll).toEqual([{ factorId: "factor-abandonado" }]);
    expect(mfaFakes.calls.enroll).toHaveLength(0);
  });

  it("salir de /admin/mfa (desmontaje real) y volver a entrar más tarde no deja al usuario bloqueado", async () => {
    authenticated();
    mfaFakes.aalResult = { data: { currentLevel: "aal1" }, error: null };
    mfaFakes.factorsResult = abandonedFactorsResult("factor-abandonado");

    // Primera entrada: se detecta el enrolamiento abandonado (p. ej. de una sesión de
    // navegador anterior). Se abandona la página sin actuar (desmontaje real).
    const firstVisit = renderMfaPage();
    await screen.findByRole("button", { name: /configurar autenticador/i });
    firstVisit.unmount();

    // Segunda entrada, más tarde: el estado server-side (listFactors) sigue reportando
    // el mismo factor abandonado — el componente vuelto a montar debe seguir pudiendo
    // limpiarlo y continuar, nunca quedar atascado.
    mfaFakes.enrollResult = {
      data: {
        id: "factor-limpio-2",
        type: "totp",
        totp: {
          qr_code: "<svg>otra-vez</svg>",
          secret: "OTRO-SECRETO",
          uri: "otpauth://totp/z",
        },
      },
      error: null,
    };
    renderMfaPage();

    fireEvent.click(
      await screen.findByRole("button", { name: /configurar autenticador/i }),
    );

    await screen.findByAltText(/código qr/i);
    expect(mfaFakes.calls.unenroll).toEqual([{ factorId: "factor-abandonado" }]);
    expect(mfaFakes.calls.enroll).toEqual([{ factorType: "totp" }]);
  });

  it("el secret/QR del enrolamiento de recuperación solo vive en memoria (nunca localStorage/sessionStorage)", async () => {
    authenticated();
    mfaFakes.aalResult = { data: { currentLevel: "aal1" }, error: null };
    mfaFakes.factorsResult = abandonedFactorsResult();
    mfaFakes.enrollResult = {
      data: {
        id: "factor-limpio",
        type: "totp",
        totp: {
          qr_code: "<svg>x</svg>",
          secret: "SECRETO-EN-MEMORIA",
          uri: "otpauth://totp/x",
        },
      },
      error: null,
    };
    const localStorageSpy = vi.spyOn(Storage.prototype, "setItem");
    renderMfaPage();

    fireEvent.click(
      await screen.findByRole("button", { name: /configurar autenticador/i }),
    );
    await screen.findByAltText(/código qr/i);

    expect(localStorageSpy).not.toHaveBeenCalled();
  });
});

describe("AdminMfaPage — fallos de carga", () => {
  it("fallo al comprobar el AAL muestra un error seguro, sin listFactors", async () => {
    authenticated();
    mfaFakes.aalResult = {
      data: null,
      error: Object.assign(new Error("jwt malformed: internal"), { code: "bad_jwt" }),
    };
    renderMfaPage();

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe(
      "No se pudo comprobar tu estado de verificación en dos pasos.",
    );
    expect(alert.textContent).not.toMatch(/jwt malformed/i);
    expect(mfaFakes.calls.listFactors).toBe(0);
  });

  it("fallo al cargar factores muestra un error seguro, sin enroll/challenge", async () => {
    authenticated();
    mfaFakes.aalResult = { data: { currentLevel: "aal1" }, error: null };
    mfaFakes.factorsResult = {
      data: null,
      error: Object.assign(new Error("relation admin_roles does not exist"), {
        code: "unexpected_failure",
      }),
    };
    renderMfaPage();

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe("No se pudieron cargar tus factores de verificación.");
    expect(alert.textContent).not.toMatch(/relation admin_roles/i);
    expect(mfaFakes.calls.enroll).toHaveLength(0);
  });
});

describe("AdminMfaPage — sin consulta cliente a admin_roles", () => {
  it("el código fuente de la página nunca consulta la tabla admin_roles (ni con .from(), ni con una query cruda)", () => {
    // Vitest ejecuta con cwd = raíz del proyecto (mismo patrón que
    // instagram-resource-router.test.ts al leer vercel.json). No basta con buscar la
    // palabra "admin_roles" (el propio comentario de cabecera la nombra a propósito
    // para documentar esta invariante): se busca específicamente un acceso a la tabla.
    const source = readFileSync(
      join(process.cwd(), "src/pages/admin/AdminMfaPage.tsx"),
      "utf-8",
    );
    expect(source).not.toMatch(/\.from\(\s*["']admin_roles["']\s*\)/);
    expect(source).not.toMatch(/supabase\s*\.\s*from/);
  });
});
