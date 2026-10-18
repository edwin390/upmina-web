import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { IntlProvider } from "use-intl";
import LiveBadge from "./LiveBadge";

// El número de viewers solo se muestra con el estado "live": con "error" (consulta fallida con dato anterior
// conservado por TanStack), "offline" o "loading" nunca se presenta un número como vigente.
const messages = {
  site: {
    twitch: {
      badge: {
        loading: "Comprobando",
        live: "EN VIVO",
        offline: "OFFLINE",
        error: "ERROR",
        viewers: "{count} viewers",
      },
    },
  },
};
const renderBadge = (
  status: "loading" | "live" | "offline" | "error",
  viewerCount?: number,
) =>
  render(
    <IntlProvider locale="es" messages={messages}>
      <LiveBadge status={status} viewerCount={viewerCount} />
    </IntlProvider>,
  );

describe("LiveBadge", () => {
  it("live muestra los viewers", () => {
    renderBadge("live", 42);
    expect(screen.getByText("42 viewers")).toBeInTheDocument();
  });
  it.each(["error", "offline", "loading"] as const)(
    "%s no muestra viewers aunque haya un número anterior",
    (s) => {
      renderBadge(s, 42);
      expect(screen.queryByText(/viewers/)).toBeNull();
    },
  );
});
