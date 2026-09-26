import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { VercelRequest, VercelResponse } from "@vercel/node";
import videosHandler from "../../api/youtube-videos";
import { pickCoverUrl, resetYouTubeCacheForTests } from "./youtube-shared";

// Portadas de YouTube (9H-2.5 pulido): la API ya entrega varias variantes por video; se elige la
// mejor disponible sin peticiones extra ni URLs construidas. Google simulado, sin red.

const T = (name: string) => ({ url: `https://i.ytimg.com/vi/abc/${name}.jpg` });

describe("pickCoverUrl", () => {
  it("prefiere maxres, luego standard, luego high", () => {
    expect(
      pickCoverUrl({
        maxres: T("maxres"),
        standard: T("sd"),
        high: T("hq"),
        default: T("d"),
      }),
    ).toBe(T("maxres").url);
    expect(pickCoverUrl({ standard: T("sd"), high: T("hq"), default: T("d") })).toBe(
      T("sd").url,
    );
  });

  it("si la mejor es high no repite la URL (la portada es la miniatura)", () => {
    expect(pickCoverUrl({ high: T("hq"), default: T("d") })).toBeUndefined();
  });

  it("sin variantes útiles devuelve undefined (nunca construye una URL)", () => {
    expect(pickCoverUrl(undefined)).toBeUndefined();
    expect(pickCoverUrl({})).toBeUndefined();
    expect(pickCoverUrl({ default: T("d") })).toBeUndefined();
  });

  it("ignora entradas malformadas y cae a la siguiente variante válida", () => {
    const bad = [
      { url: "" },
      { url: undefined },
      { url: 42 },
      { url: "javascript:alert(1)" },
      { url: "http://i.ytimg.com/vi/abc/maxres.jpg" },
      null,
      "texto",
    ];
    for (const value of bad) {
      expect(
        pickCoverUrl({ maxres: value, standard: T("sd"), high: T("hq") } as never),
      ).toBe(T("sd").url);
    }
    expect(pickCoverUrl({ maxres: { url: "" }, high: T("hq") } as never)).toBeUndefined();
    expect(pickCoverUrl("no-objeto" as never)).toBeUndefined();
  });
});

describe("respuesta del endpoint", () => {
  const json = (body: unknown) =>
    new Response(JSON.stringify(body), {
      headers: { "content-type": "application/json" },
    });
  const original = { ...process.env };

  const stub = (thumbs: Record<string, unknown>) =>
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        const op = new URL(url).pathname.split("/").pop();
        if (op === "channels") {
          return json({
            items: [{ contentDetails: { relatedPlaylists: { uploads: "UU1" } } }],
          });
        }
        if (op === "playlistItems") {
          return json({
            items: Object.entries(thumbs).map(([id, thumbnails], i) => ({
              snippet: {
                resourceId: { videoId: id },
                title: id,
                description: "",
                thumbnails,
                publishedAt: new Date(
                  Date.UTC(2026, 8, 25) - i * 3_600_000,
                ).toISOString(),
              },
            })),
          });
        }
        return json({
          items: Object.keys(thumbs).map((id) => ({
            id,
            contentDetails: { duration: "PT20S" },
          })),
        });
      }),
    );

  async function shorts() {
    const state: { body?: unknown } = {};
    const res = {
      setHeader: () => res,
      status: () => res,
      json: (b: unknown) => ((state.body = b), res),
    };
    await videosHandler(
      {
        method: "GET",
        query: { type: "shorts", maxResults: "24" },
      } as unknown as VercelRequest,
      res as unknown as VercelResponse,
    );
    return state.body as { id: string; thumbnailUrl?: string; coverUrl?: string }[];
  }

  beforeEach(() => {
    Object.assign(process.env, {
      YOUTUBE_API_KEY: "clave-sintetica",
      YOUTUBE_CHANNEL_ID: "UCtest",
    });
    resetYouTubeCacheForTests();
  });
  afterEach(() => {
    process.env = { ...original };
    vi.unstubAllGlobals();
    resetYouTubeCacheForTests();
  });

  it("cada video recibe su mejor variante; sin maxres cae a standard; sin ambas no hay coverUrl", async () => {
    stub({
      a: { maxres: T("maxres"), standard: T("sd"), high: T("hq"), default: T("d") },
      b: { standard: T("sd"), high: T("hq"), default: T("d") },
      c: { high: T("hq"), default: T("d") },
      d: {},
    });

    const body = await shorts();
    const by = Object.fromEntries(body.map((v) => [v.id, v]));

    expect(by.a.coverUrl).toBe(T("maxres").url);
    expect(by.a.thumbnailUrl).toBe(T("hq").url);
    expect(by.b.coverUrl).toBe(T("sd").url);
    expect(by.c.coverUrl).toBeUndefined();
    expect("coverUrl" in by.c).toBe(false);
    expect(by.c.thumbnailUrl).toBe(T("hq").url);
    expect(by.d.coverUrl).toBeUndefined();
    expect(by.d.thumbnailUrl).toBeUndefined();
  });

  it("no añade peticiones a Google (mismo trabajo: channels + playlistItems + videos)", async () => {
    stub({ a: { maxres: T("maxres"), high: T("hq") } });
    await shorts();

    expect((fetch as unknown as { mock: { calls: unknown[] } }).mock.calls).toHaveLength(
      3,
    );
  });
});
