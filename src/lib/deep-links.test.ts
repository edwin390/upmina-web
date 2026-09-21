import { describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { useContentNotice } from "@/hooks/useContentNotice";
import {
  isTwitchClipId,
  isYouTubeVideoId,
  twitchClipPath,
  youTubeVideoPath,
} from "./deep-links";

describe("validación de ids", () => {
  it("YouTube: exactamente 11 caracteres [A-Za-z0-9_-]", () => {
    for (const ok of ["dQw4w9WgXcQ", "abc_DEF-123", "-----------"]) {
      expect(isYouTubeVideoId(ok)).toBe(true);
    }
    for (const bad of [
      "",
      "corto",
      "demasiado_largo_1",
      "con espacios",
      "áéíóúñ12345",
      "a/b?c=d123",
      null,
      undefined,
      42,
    ]) {
      expect(isYouTubeVideoId(bad)).toBe(false);
    }
  });

  it("Twitch: 1 a 100 caracteres [A-Za-z0-9_-]", () => {
    expect(isTwitchClipId("PoorFunnyCheesecakeBudBlast-Ee2EEOQUhH06L6oU")).toBe(true);
    expect(isTwitchClipId("a")).toBe(true);
    expect(isTwitchClipId("a".repeat(100))).toBe(true);
    for (const bad of [
      "",
      "a".repeat(101),
      "../x",
      "a b",
      "a&b=c",
      "<script>",
      null,
      undefined,
    ]) {
      expect(isTwitchClipId(bad)).toBe(false);
    }
  });
});

describe("rutas de deep link", () => {
  it("con id válido llevan el parámetro; sin id válido, la ruta normal (nunca undefined/null)", () => {
    expect(youTubeVideoPath("dQw4w9WgXcQ")).toBe("/youtube?video=dQw4w9WgXcQ");
    expect(twitchClipPath("Clip1-abc")).toBe("/twitch?clip=Clip1-abc");
    for (const bad of [undefined, null, "", "mal id"]) {
      expect(youTubeVideoPath(bad)).toBe("/youtube");
      expect(twitchClipPath(bad)).toBe("/twitch");
    }
  });
});

describe("useContentNotice", () => {
  it("se muestra y desaparece solo; desmontar cancela el temporizador", () => {
    vi.useFakeTimers();
    const { result, unmount } = renderHook(() => useContentNotice(6000));
    expect(result.current.visible).toBe(false);

    act(() => result.current.show());
    expect(result.current.visible).toBe(true);
    act(() => {
      vi.advanceTimersByTime(5999);
    });
    expect(result.current.visible).toBe(true);
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(result.current.visible).toBe(false);

    act(() => result.current.show());
    expect(vi.getTimerCount()).toBe(1);
    unmount();
    expect(vi.getTimerCount()).toBe(0);
    vi.useRealTimers();
  });
});
