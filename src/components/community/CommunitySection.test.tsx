import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import CommunitySection from "./CommunitySection";

// /comunidad (9J-1C UX follow-up): confirma que el prototipo legado (formulario de subida de
// "edits" en vídeo, tabla `edits` inexistente) ya NO está montado y que el cascarón mínimo usa
// EXACTAMENTE la nomenclatura congelada ("Populares", nunca el nombre legado "Top semanal").

describe("CommunitySection (/comunidad) — cascarón sin creador legado", () => {
  it("no expone el creador legado: sin título, sin descripción, sin selector de vídeo, sin 'Subir edit'", () => {
    render(<CommunitySection />);

    expect(screen.queryByText("Sube tu edit")).toBeNull();
    expect(screen.queryByLabelText("Título")).toBeNull();
    expect(screen.queryByLabelText("Descripción")).toBeNull();
    expect(screen.queryByLabelText(/Video \(mp4\/webm/)).toBeNull();
    expect(screen.queryByRole("button", { name: "Subir edit" })).toBeNull();
    expect(screen.queryByText(/mp4|webm/i)).toBeNull();
  });

  it('no expone ningún <input type="file"> (sin subida de ningún tipo desde /comunidad)', () => {
    const { container } = render(<CommunitySection />);
    expect(container.querySelector('input[type="file"]')).toBeNull();
  });

  it("muestra 'Recientes' y 'Populares' (nunca el nombre legado 'Top semanal')", () => {
    render(<CommunitySection />);
    expect(screen.getByText("Recientes")).toBeInTheDocument();
    expect(screen.getByText("Populares")).toBeInTheDocument();
    expect(screen.queryByText("Top semanal")).toBeNull();
  });

  it("no inventa datos de feed: ningún voto ni tarjeta de contenido, solo el placeholder neutro", () => {
    render(<CommunitySection />);
    expect(screen.queryByText(/votos?/i)).toBeNull();
    expect(screen.getByRole("status")).toHaveTextContent("Todavía no hay publicaciones");
  });
});
