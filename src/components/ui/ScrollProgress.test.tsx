import { Profiler } from "react";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type MockInstance,
} from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import ScrollProgress from "./ScrollProgress";

// Fija que la barra de progreso se actualiza escalando el elemento (sin setState de React por evento de
// scroll) y como máximo una vez por frame.

let frames: FrameRequestCallback[] = [];
let scrollHeight: MockInstance<() => number>;

function flushFrame() {
  const pending = frames;
  frames = [];
  act(() => pending.forEach((callback) => callback(0)));
}

function scrollTo(y: number) {
  Object.defineProperty(window, "scrollY", { value: y, configurable: true });
  window.dispatchEvent(new Event("scroll"));
}

function bar(container: HTMLElement) {
  return container.firstElementChild as HTMLElement;
}

describe("ScrollProgress", () => {
  beforeEach(() => {
    frames = [];
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      frames.push(callback);
      return frames.length;
    });
    vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => {
      frames = [];
    });
    scrollHeight = vi
      .spyOn(document.documentElement, "scrollHeight", "get")
      .mockReturnValue(1500);
    Object.defineProperty(window, "innerHeight", { value: 500, configurable: true });
    Object.defineProperty(window, "scrollY", { value: 0, configurable: true });
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("empieza vacía y se escala con el progreso del scroll", () => {
    const { container } = render(<ScrollProgress />);
    expect(bar(container).style.transform).toBe("scaleX(0)");

    scrollTo(250);
    flushFrame();
    expect(bar(container).style.transform).toBe("scaleX(0.25)");

    scrollTo(1000);
    flushFrame();
    expect(bar(container).style.transform).toBe("scaleX(1)");
  });

  it("sigue el scroll sin transición y en su propia capa (sin retraso ni repintado)", () => {
    const { container } = render(<ScrollProgress />);
    expect(bar(container).className).not.toMatch(/transition/);
    expect(bar(container).className).toContain("will-change-transform");
  });

  it("no rompe si la página no tiene scroll", () => {
    scrollHeight.mockReturnValue(500);
    const { container } = render(<ScrollProgress />);
    expect(bar(container).style.transform).toBe("scaleX(0)");
  });

  it("agrupa varios eventos de scroll en un solo frame", () => {
    render(<ScrollProgress />);
    frames = [];
    scrollTo(100);
    scrollTo(200);
    scrollTo(300);
    expect(frames).toHaveLength(1);
  });

  it("no provoca renders de React por evento de scroll", () => {
    const onRender = vi.fn();
    render(
      <Profiler id="scroll-progress" onRender={onRender}>
        <ScrollProgress />
      </Profiler>,
    );
    const afterMount = onRender.mock.calls.length;

    for (let y = 0; y <= 1000; y += 100) {
      scrollTo(y);
      flushFrame();
    }
    expect(onRender.mock.calls.length).toBe(afterMount);
  });

  it("se recalcula al cambiar el tamaño de la ventana", () => {
    const { container } = render(<ScrollProgress />);
    scrollTo(500);
    flushFrame();
    expect(bar(container).style.transform).toBe("scaleX(0.5)");

    scrollHeight.mockReturnValue(2500); // scrollable = 2000
    window.dispatchEvent(new Event("resize"));
    flushFrame();
    expect(bar(container).style.transform).toBe("scaleX(0.25)");
  });

  it("deja de escuchar al desmontarse", () => {
    const { container, unmount } = render(<ScrollProgress />);
    const element = bar(container);
    unmount();
    scrollTo(500);
    expect(frames).toHaveLength(0);
    expect(element.style.transform).toBe("scaleX(0)");
  });
});
