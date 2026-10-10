import { render, screen, within } from "@testing-library/react";
import { IntlProvider } from "use-intl";
import { describe, expect, it } from "vitest";
import { MODERATION_AUDIT_ACTIONS } from "@/lib/moderation-case-contract";
import de from "@/i18n/locales/de/moderation.json";
import en from "@/i18n/locales/en/moderation.json";
import es from "@/i18n/locales/es/moderation.json";
import ModerationAuditList from "./ModerationAuditList";

type Item = Parameters<typeof ModerationAuditList>[0]["audit"][number];

const LOCALES = { es, en, de } as const;
const NO_STATES = {
  fromPostStatus: null,
  toPostStatus: null,
  fromReportStatus: null,
  toReportStatus: null,
};
const item = (over: Partial<Item> & { id: string }): Item => ({
  action: "post_quarantined",
  actorKind: "system",
  createdAt: "2026-10-05T13:45:00Z",
  states: NO_STATES,
  strikeLevel: null,
  ...over,
});

function renderList(audit: Item[], locale: keyof typeof LOCALES = "es") {
  return render(
    <IntlProvider locale={locale} messages={{ moderation: LOCALES[locale] } as never}>
      <ModerationAuditList audit={audit} />
    </IntlProvider>,
  );
}

describe("ModerationAuditList · etiquetas legibles", () => {
  it.each(MODERATION_AUDIT_ACTIONS)(
    "%s se muestra con etiqueta y descripción, nunca con el código crudo (es/en/de)",
    (action) => {
      for (const locale of ["es", "en", "de"] as const) {
        const { unmount } = renderList(
          [
            item({
              id: "a1",
              action,
              actorKind:
                action === "post_quarantined" || action === "post_purged"
                  ? "system"
                  : "human",
              strikeLevel: action.startsWith("strike_") ? 2 : null,
            }),
          ],
          locale,
        );
        const entry = screen.getByRole("listitem");
        const texts = LOCALES[locale].audit.actions[action];
        expect(entry).toHaveTextContent(texts.label);
        expect(entry).toHaveTextContent(texts.description);
        expect(entry.textContent).not.toContain(action);
        unmount();
      }
    },
  );

  it("cada acción real tiene etiqueta y descripción en los tres idiomas", () => {
    for (const locale of Object.values(LOCALES))
      for (const action of MODERATION_AUDIT_ACTIONS) {
        expect(locale.audit.actions[action].label.trim()).not.toBe("");
        expect(locale.audit.actions[action].description.trim()).not.toBe("");
      }
  });

  it("distingue acciones automáticas, humanas, restauraciones, decisiones y sanciones (texto + categoría)", () => {
    renderList([
      item({ id: "1", action: "post_quarantined", actorKind: "system" }),
      item({ id: "2", action: "post_restored", actorKind: "human" }),
      item({ id: "3", action: "content_actioned", actorKind: "human" }),
      item({ id: "4", action: "strike_applied", actorKind: "human", strikeLevel: 3 }),
      item({ id: "5", action: "post_hidden", actorKind: "human" }),
    ]);
    const cats = screen.getAllByRole("listitem").map((li) => li.dataset.category);
    expect(cats).toEqual([
      "automatic",
      "restoration",
      "decision",
      "sanction",
      "moderation",
    ]);
    const items = screen.getAllByRole("listitem");
    expect(items[0]).toHaveTextContent("Automática");
    expect(items[0]).toHaveTextContent("Sistema");
    expect(items[1]).toHaveTextContent("Restauración");
    expect(items[1]).toHaveTextContent("Acción humana");
    expect(items[3]).toHaveTextContent("Sanción");
    expect(items[3]).toHaveTextContent("Strike 3");
  });

  it("el evento del sistema siempre cuenta como automático, aunque la acción sea de otro tipo", () => {
    renderList([item({ id: "1", action: "post_purged", actorKind: "system" })]);
    expect(screen.getByRole("listitem").dataset.category).toBe("automatic");
  });

  it("muestra las transiciones de estado traducidas, sin códigos crudos", () => {
    renderList(
      [
        item({
          id: "1",
          action: "case_rejected",
          actorKind: "human",
          states: {
            fromPostStatus: "hidden_pending_review",
            toPostStatus: "published",
            fromReportStatus: "open",
            toReportStatus: "dismissed",
          },
        }),
      ],
      "es",
    );
    const entry = screen.getByRole("listitem");
    expect(entry).toHaveTextContent(
      "Publicación: Oculta preventivamente → Publicada · Reporte: Abierto → Descartado",
    );
    expect(entry.textContent).not.toMatch(/hidden_pending_review|dismissed/);
  });

  it("traduce también las transiciones al inglés y al alemán", () => {
    const states = {
      fromPostStatus: "published",
      toPostStatus: "removed_pending_purge",
      fromReportStatus: null,
      toReportStatus: null,
    };
    const { unmount } = renderList(
      [item({ id: "1", action: "content_actioned", actorKind: "human", states })],
      "en",
    );
    expect(screen.getByRole("listitem")).toHaveTextContent(
      "Post: Published → Removed by moderation",
    );
    unmount();
    renderList(
      [item({ id: "1", action: "content_actioned", actorKind: "human", states })],
      "de",
    );
    expect(screen.getByRole("listitem")).toHaveTextContent(
      "Beitrag: Veröffentlicht → Von der Moderation entfernt",
    );
  });

  it("sin transiciones no se pinta la línea de estados", () => {
    renderList([item({ id: "1", action: "post_purged" })]);
    expect(screen.getByRole("listitem").textContent).not.toContain("→");
  });

  it("un estado desconocido nunca se vuelca crudo: se sustituye por «—»", () => {
    renderList([
      item({
        id: "1",
        action: "post_hidden",
        actorKind: "human",
        states: { ...NO_STATES, fromPostStatus: "estado_futuro", toPostStatus: "hidden" },
      }),
    ]);
    const entry = screen.getByRole("listitem");
    expect(entry).toHaveTextContent("Publicación: — → Oculta");
    expect(entry.textContent).not.toContain("estado_futuro");
  });
});

describe("ModerationAuditList · eventos desconocidos", () => {
  it("una acción no reconocida usa una etiqueta genérica y no vuelca el código", () => {
    renderList([
      item({
        id: "1",
        action: "accion_futura" as unknown as Item["action"],
        actorKind: "human",
      }),
    ]);
    const entry = screen.getByRole("listitem");
    expect(entry).toHaveTextContent("Acción no reconocida");
    expect(entry).toHaveTextContent("no sabe describirla");
    expect(entry.textContent).not.toContain("accion_futura");
    expect(entry.dataset.category).toBe("moderation");
  });
});

describe("ModerationAuditList · fechas, vacío y accesibilidad", () => {
  it("usa el idioma activo para la fecha y marca <time> con el instante ISO", () => {
    const iso = "2026-10-05T13:45:00Z";
    const { unmount } = renderList([item({ id: "1", createdAt: iso })], "es");
    const es = screen.getByRole("listitem").querySelector("time")!;
    expect(es.getAttribute("datetime")).toBe(iso);
    const esText = es.textContent;
    unmount();
    renderList([item({ id: "1", createdAt: iso })], "en");
    const enText = screen.getByRole("listitem").querySelector("time")!.textContent;
    expect(esText).toBe(
      new Intl.DateTimeFormat("es", { dateStyle: "medium", timeStyle: "short" }).format(
        new Date(iso),
      ),
    );
    expect(enText).toBe(
      new Intl.DateTimeFormat("en", { dateStyle: "medium", timeStyle: "short" }).format(
        new Date(iso),
      ),
    );
    expect(enText).not.toBe(esText);
  });

  it("estado vacío explícito, con región y encabezado", () => {
    renderList([]);
    const region = screen.getByRole("region", { name: "Auditoría reciente" });
    expect(within(region).getByRole("heading")).toHaveTextContent(
      "Auditoría reciente de publicación/caso (hasta 20 acciones)",
    );
    expect(region).toHaveTextContent("Todavía no hay acciones registradas");
    expect(screen.queryByRole("listitem")).toBeNull();
  });

  it("la región se llama igual en cada idioma que su traducción", () => {
    for (const locale of ["en", "de"] as const) {
      const { unmount } = renderList([], locale);
      expect(
        screen.getByRole("region", { name: LOCALES[locale].audit.regionLabel }),
      ).toBeInTheDocument();
      unmount();
    }
  });

  it("el texto largo se parte (sin desbordar) y la categoría no depende solo del color", () => {
    renderList([
      item({ id: "1", action: "strike_revoked", actorKind: "human", strikeLevel: 1 }),
    ]);
    const entry = screen.getByRole("listitem");
    expect(entry.className).toContain("break-words");
    expect(entry).toHaveTextContent("Sanción"); // insignia textual además del borde
  });
});

describe("ModerationAuditList · privacidad del actor", () => {
  it("solo distingue sistema / acción humana: ningún identificador, correo ni rol salen del contrato", () => {
    const leaky = {
      ...item({ id: "1", action: "content_actioned", actorKind: "human" }),
      actorUserId: "0e000000-0000-4000-8000-000000000001",
      actorEmail: "moderador@example.test",
      actorRole: "ROL-SECRETO",
      metadata: { reporter: "REPORTANTE-SECRETO" },
    } as Item;
    renderList([leaky]);
    const text = screen.getByRole("region", { name: "Auditoría reciente" }).textContent!;
    for (const secret of [
      "0e000000",
      "example.test",
      "ROL-SECRETO",
      "REPORTANTE-SECRETO",
      "actorUserId",
    ])
      expect(text).not.toContain(secret);
    expect(text).toContain("Acción humana");
  });
});
