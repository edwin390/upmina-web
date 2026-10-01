import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import ActionNotice from "./ActionNotice";
import { showActionSuccess } from "@/lib/action-notice";

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  act(() => vi.runAllTimers());
  cleanup();
  vi.useRealTimers();
});

it("success survives its triggering editor unmount and auto-expires without duplicate notices", () => {
  const view = render(
    <>
      <ActionNotice />
      <div data-testid="editor" />
    </>,
  );
  act(() => showActionSuccess("Borrador guardado correctamente"));
  view.rerender(<ActionNotice />);
  expect(screen.getByRole("status")).toHaveTextContent("Borrador guardado correctamente");
  expect(document.body.contains(screen.getByRole("status"))).toBe(true);
  act(() => vi.advanceTimersByTime(4000));
  expect(screen.getByRole("status")).toBeInTheDocument();
  act(() => showActionSuccess("Publicación actualizada correctamente"));
  expect(screen.getAllByRole("status")).toHaveLength(1);
  act(() => vi.advanceTimersByTime(6000));
  expect(screen.queryByRole("status")).toBeNull();
});
