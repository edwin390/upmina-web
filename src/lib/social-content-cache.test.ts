import { afterEach, describe, expect, it } from "vitest";
import { QueryClient } from "@tanstack/react-query";
import {
  installSocialContentCacheListener,
  notifySocialDisconnected,
} from "./social-content-cache";

describe("contenido social en el navegador", () => {
  let off: (() => void) | undefined;
  afterEach(() => off?.());

  it("al desconectar se reinician solo las consultas de ese proveedor", async () => {
    const qc = new QueryClient();
    qc.setQueryData(["tiktok", "videos"], [{ id: "v" }]);
    qc.setQueryData(["instagram", "feed"], [{ id: "i" }]);
    qc.setQueryData(["instagram", "profile"], { username: "u" });
    off = installSocialContentCacheListener(qc);
    notifySocialDisconnected("instagram");
    await Promise.resolve();
    expect(qc.getQueryData(["instagram", "feed"])).toBeUndefined();
    expect(qc.getQueryData(["instagram", "profile"])).toBeUndefined();
    expect(qc.getQueryData(["tiktok", "videos"])).toEqual([{ id: "v" }]);
  });

  it("ignora mensajes de proveedores desconocidos", async () => {
    const qc = new QueryClient();
    qc.setQueryData(["tiktok", "videos"], [1]);
    off = installSocialContentCacheListener(qc);
    window.dispatchEvent(
      new CustomEvent("upmina:social-disconnected", { detail: "twitch" }),
    );
    expect(qc.getQueryData(["tiktok", "videos"])).toEqual([1]);
  });
});
