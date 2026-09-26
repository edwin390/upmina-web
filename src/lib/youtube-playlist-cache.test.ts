import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { VercelRequest, VercelResponse } from "@vercel/node";
import latestHandler from "../../api/youtube-latest";
import videosHandler from "../../api/youtube-videos";
import {
  UPLOADS_PLAYLIST_TTL_MS,
  getUploadsPlaylistId,
  resetYouTubeCacheForTests,
} from "./youtube-shared";

// Caché en memoria de la playlist de subidas (9H-2): un acierto no llama a Google, la entrada
// caduca, va ligada al canal, solo guarda ids validados de respuestas correctas, nunca crece y las
// resoluciones simultáneas comparten una sola llamada. Determinista: reloj falso, sin red.

const API_KEY = "AIzaSy-clave-sintetica-de-prueba";
const CHANNEL_A = "UCcanal-A-de-prueba";
const CHANNEL_B = "UCcanal-B-de-prueba";

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });

const channelBody = (uploads: unknown) => ({
  items: [{ contentDetails: { relatedPlaylists: { uploads } } }],
});

type Operation = "channels" | "playlistItems" | "videos";

function stubGoogle(
  channels: (
    n: number,
    channelId: string,
    init?: RequestInit,
  ) => Response | Promise<Response>,
) {
  const calls: Record<Operation, number> = { channels: 0, playlistItems: 0, videos: 0 };
  const channelIds: string[] = [];
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    const parsed = new URL(url);
    const operation = parsed.pathname.split("/").pop() as Operation;
    calls[operation]++;
    if (operation === "channels") {
      const id = parsed.searchParams.get("id") ?? "";
      channelIds.push(id);
      return channels(calls.channels, id, init);
    }
    if (operation === "playlistItems") {
      return json({
        items: [
          {
            snippet: {
              resourceId: { videoId: "vid1" },
              title: "Video 1",
              description: "",
              thumbnails: { high: { url: "https://i.ytimg.com/vi/vid1/hqdefault.jpg" } },
              publishedAt: "2026-09-18T19:00:31Z",
            },
          },
        ],
      });
    }
    return json({ items: [{ id: "vid1", contentDetails: { duration: "PT8M38S" } }] });
  });
  vi.stubGlobal("fetch", fetchMock);
  return { calls, channelIds, fetchMock };
}

const okChannel =
  (uploads: string = "UUuploads") =>
  () =>
    json(channelBody(uploads));

function mockRes() {
  const state: { status?: number; body?: unknown; headers: Record<string, string> } = {
    headers: {},
  };
  const res = {
    setHeader(name: string, value: string) {
      state.headers[name] = value;
      return res;
    },
    status(code: number) {
      state.status = code;
      return res;
    },
    json(body: unknown) {
      state.body = body;
      return res;
    },
  };
  return { res: res as unknown as VercelResponse, state };
}
const req = (query: Record<string, string> = {}) =>
  ({ method: "GET", query }) as unknown as VercelRequest;

const originalEnv = { ...process.env };

beforeEach(() => {
  Object.assign(process.env, { YOUTUBE_API_KEY: API_KEY, YOUTUBE_CHANNEL_ID: CHANNEL_A });
  resetYouTubeCacheForTests();
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.useFakeTimers();
});

afterEach(() => {
  process.env = { ...originalEnv };
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  resetYouTubeCacheForTests();
});

describe("acierto y fallo de caché", () => {
  it("la primera consulta llama a Google y la siguiente NO", async () => {
    const { calls } = stubGoogle(okChannel("UUplaylistA"));

    expect(await getUploadsPlaylistId()).toBe("UUplaylistA");
    expect(await getUploadsPlaylistId()).toBe("UUplaylistA");
    expect(await getUploadsPlaylistId()).toBe("UUplaylistA");

    expect(calls.channels).toBe(1);
  });

  it("el TTL es de 6 horas", () => {
    expect(UPLOADS_PLAYLIST_TTL_MS).toBe(6 * 60 * 60 * 1000);
  });

  it("dentro del TTL sigue en caché; al vencer se refresca", async () => {
    const { calls } = stubGoogle((n) =>
      json(channelBody(n === 1 ? "UUviejo" : "UUnuevo")),
    );

    expect(await getUploadsPlaylistId()).toBe("UUviejo");
    await vi.advanceTimersByTimeAsync(UPLOADS_PLAYLIST_TTL_MS - 1);
    expect(await getUploadsPlaylistId()).toBe("UUviejo");
    expect(calls.channels).toBe(1);

    await vi.advanceTimersByTimeAsync(1);
    expect(await getUploadsPlaylistId()).toBe("UUnuevo");
    expect(calls.channels).toBe(2);
  });

  it("un canal distinto NO reutiliza la entrada de otro (ligada al id del canal)", async () => {
    const { calls, channelIds } = stubGoogle((_n, channelId) =>
      json(channelBody(channelId === CHANNEL_A ? "UUplaylistA" : "UUplaylistB")),
    );

    expect(await getUploadsPlaylistId()).toBe("UUplaylistA");
    process.env.YOUTUBE_CHANNEL_ID = CHANNEL_B;
    expect(await getUploadsPlaylistId()).toBe("UUplaylistB");
    // Volver al primero tampoco sirve la playlist del segundo.
    process.env.YOUTUBE_CHANNEL_ID = CHANNEL_A;
    expect(await getUploadsPlaylistId()).toBe("UUplaylistA");

    expect(channelIds).toEqual([CHANNEL_A, CHANNEL_B, CHANNEL_A]);
    expect(calls.channels).toBe(3);
  });

  it("acotada: una sola entrada (no hay estructura que crezca con muchos canales)", async () => {
    const { calls } = stubGoogle((_n, channelId) => json(channelBody(`UU${channelId}`)));

    for (let i = 0; i < 200; i++) {
      process.env.YOUTUBE_CHANNEL_ID = `UCcanal${i}`;
      await getUploadsPlaylistId();
    }
    // Solo el ÚLTIMO canal sigue en caché: el anterior ya se evictó (una sola entrada).
    process.env.YOUTUBE_CHANNEL_ID = "UCcanal199";
    await getUploadsPlaylistId();
    expect(calls.channels).toBe(200);
    process.env.YOUTUBE_CHANNEL_ID = "UCcanal198";
    await getUploadsPlaylistId();
    expect(calls.channels).toBe(201);
  });

  it("la configuración se comprueba antes que la caché: sin credenciales, 503 sin llamar a Google", async () => {
    const { calls } = stubGoogle(okChannel());
    await getUploadsPlaylistId();

    delete process.env.YOUTUBE_API_KEY;
    await expect(getUploadsPlaylistId()).rejects.toMatchObject({ status: 503 });

    expect(calls.channels).toBe(1);
  });
});

describe("los fallos no se cachean ni envenenan la caché", () => {
  it.each([
    ["429", () => json({}, 429, { "Retry-After": "30" })],
    ["503", () => json({ error: { errors: [{ reason: "backendError" }] } }, 503)],
    [
      "403 quotaExceeded",
      () => json({ error: { errors: [{ reason: "quotaExceeded" }] } }, 403),
    ],
    ["cuerpo no JSON", () => new Response("<html>", { status: 200 })],
    ["canal inexistente (sin items)", () => json({ items: [] })],
    [
      "items sin playlist",
      () => json({ items: [{ contentDetails: { relatedPlaylists: {} } }] }),
    ],
  ] as const)(
    "%s: no se guarda y el siguiente intento vuelve a Google",
    async (_name, failure) => {
      const { calls } = stubGoogle((n) =>
        n === 1 ? failure() : json(channelBody("UUbuena")),
      );

      await expect(getUploadsPlaylistId()).rejects.toBeDefined();
      expect(await getUploadsPlaylistId()).toBe("UUbuena");
      expect(await getUploadsPlaylistId()).toBe("UUbuena");

      expect(calls.channels).toBe(2);
    },
  );

  it("timeout: no se guarda", async () => {
    const { calls } = stubGoogle((n, _id, init) =>
      n === 1
        ? new Promise<Response>((_resolve, reject) =>
            init?.signal?.addEventListener("abort", () =>
              reject(new DOMException("aborted", "AbortError")),
            ),
          )
        : json(channelBody("UUbuena")),
    );

    const first = getUploadsPlaylistId();
    const assertion = expect(first).rejects.toMatchObject({ kind: "TIMEOUT" });
    await vi.advanceTimersByTimeAsync(8_000);
    await assertion;

    expect(await getUploadsPlaylistId()).toBe("UUbuena");
    expect(calls.channels).toBe(2);
  });

  it.each([
    ["vacío", ""],
    ["solo espacios", "   "],
    ["con espacios", "UU con espacios"],
    ["con barras (ruta)", "UU/../x"],
    ["con query", "UUabc?key=1"],
    ["demasiado largo", "U".repeat(65)],
    ["demasiado corto", "U"],
    ["número", 12345],
    ["objeto", { id: "UUabc" }],
    ["array", ["UUabc"]],
    ["null", null],
  ])(
    "id malformado (%s): no se cachea y se trata como canal no encontrado",
    async (_name, bad) => {
      const { calls } = stubGoogle((n) => json(channelBody(n === 1 ? bad : "UUbuena")));

      await expect(getUploadsPlaylistId()).rejects.toMatchObject({
        status: 502,
        message: "YouTube channels: canal no encontrado",
      });
      expect(await getUploadsPlaylistId()).toBe("UUbuena");

      expect(calls.channels).toBe(2);
    },
  );

  it("un fallo al REFRESCAR una entrada vencida no sirve la vieja ni deja basura; el siguiente éxito la sustituye", async () => {
    const { calls } = stubGoogle((n) => {
      if (n === 1) return json(channelBody("UUviejo"));
      if (n === 2) return json({}, 503);
      return json(channelBody("UUnuevo"));
    });

    expect(await getUploadsPlaylistId()).toBe("UUviejo");
    await vi.advanceTimersByTimeAsync(UPLOADS_PLAYLIST_TTL_MS);
    await expect(getUploadsPlaylistId()).rejects.toMatchObject({ status: 502 });
    expect(await getUploadsPlaylistId()).toBe("UUnuevo");
    expect(await getUploadsPlaylistId()).toBe("UUnuevo");

    expect(calls.channels).toBe(3);
  });

  it("un fallo en playlistItems/videos NO invalida la playlist cacheada", async () => {
    let playlistFails = true;
    const calls = { channels: 0 };
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        const operation = new URL(url).pathname.split("/").pop();
        if (operation === "channels") {
          calls.channels++;
          return json(channelBody("UUplaylistA"));
        }
        return playlistFails ? json({}, 429) : json({ items: [] });
      }),
    );

    const failed = mockRes();
    await latestHandler(req(), failed.res);
    expect(failed.state.status).toBe(429);

    playlistFails = false;
    const ok = mockRes();
    await latestHandler(req(), ok.res);
    expect(ok.state.status).toBe(404); // canal sin subidas: respuesta válida distinta

    expect(calls.channels).toBe(1);
  });
});

describe("resoluciones simultáneas", () => {
  it("varias peticiones a la vez comparten UNA llamada a channels", async () => {
    const { calls } = stubGoogle(
      (_n, _id, init) =>
        new Promise<Response>((resolve, reject) => {
          const timer = setTimeout(
            () => resolve(json(channelBody("UUcompartida"))),
            1_000,
          );
          init?.signal?.addEventListener("abort", () => {
            clearTimeout(timer);
            reject(new DOMException("aborted", "AbortError"));
          });
        }),
    );

    const all = Promise.all(Array.from({ length: 5 }, () => getUploadsPlaylistId()));
    await vi.advanceTimersByTimeAsync(1_000);

    expect(await all).toEqual(Array(5).fill("UUcompartida"));
    expect(calls.channels).toBe(1);
  });

  it("si la resolución compartida falla, todas reciben el fallo y la siguiente vuelve a intentar", async () => {
    const { calls } = stubGoogle((n) =>
      n === 1 ? json({}, 503) : json(channelBody("UUbuena")),
    );

    const results = await Promise.allSettled(
      Array.from({ length: 4 }, () => getUploadsPlaylistId()),
    );

    expect(results.every((r) => r.status === "rejected")).toBe(true);
    expect(calls.channels).toBe(1);
    expect(await getUploadsPlaylistId()).toBe("UUbuena");
    expect(calls.channels).toBe(2);
  });

  it("una resolución en vuelo de otro canal no se reutiliza", async () => {
    const { channelIds } = stubGoogle(
      (_n, channelId, init) =>
        new Promise<Response>((resolve, reject) => {
          const timer = setTimeout(
            () =>
              resolve(
                json(
                  channelBody(channelId === CHANNEL_A ? "UUplaylistA" : "UUplaylistB"),
                ),
              ),
            500,
          );
          init?.signal?.addEventListener("abort", () => {
            clearTimeout(timer);
            reject(new DOMException("aborted", "AbortError"));
          });
        }),
    );

    const a = getUploadsPlaylistId();
    process.env.YOUTUBE_CHANNEL_ID = CHANNEL_B;
    const b = getUploadsPlaylistId();
    await vi.advanceTimersByTimeAsync(500);

    expect(await a).toBe("UUplaylistA");
    expect(await b).toBe("UUplaylistB");
    expect(channelIds).toEqual([CHANNEL_A, CHANNEL_B]);
  });
});

describe("efecto en las llamadas y la cuota (por instancia)", () => {
  it("youtube-latest: en frío 3 llamadas (channels + playlistItems + videos); en caliente 2", async () => {
    const { calls } = stubGoogle(okChannel());

    const cold = mockRes();
    await latestHandler(req(), cold.res);
    expect(cold.state.status).toBe(200);
    expect(calls).toEqual({ channels: 1, playlistItems: 1, videos: 1 });

    const warm = mockRes();
    await latestHandler(req(), warm.res);
    expect(warm.state.status).toBe(200);
    expect(calls).toEqual({ channels: 1, playlistItems: 2, videos: 2 });
  });

  it("youtube-videos (videos y shorts) comparten la playlist ya resuelta: 0 llamadas a channels", async () => {
    const { calls } = stubGoogle(okChannel());

    for (const type of ["videos", "shorts"]) {
      const out = mockRes();
      await videosHandler(req({ type }), out.res);
      expect(out.state.status).toBe(200);
    }

    expect(calls.channels).toBe(1);
  });

  it("las respuestas exitosas conservan su Cache-Control y los fallos no lo llevan", async () => {
    stubGoogle((n) => (n === 1 ? json({}, 503) : json(channelBody("UUuploads"))));

    const failure = mockRes();
    await latestHandler(req(), failure.res);
    expect(failure.state.status).toBe(502);
    expect(failure.state.headers["Cache-Control"]).toBeUndefined();

    const success = mockRes();
    await latestHandler(req(), success.res);
    expect(success.state.status).toBe(200);
    expect(success.state.headers["Cache-Control"]).toBe(
      "s-maxage=900, stale-while-revalidate=1800",
    );
  });
});
