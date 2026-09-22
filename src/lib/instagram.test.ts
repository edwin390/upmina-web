import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { VercelRequest, VercelResponse } from "@vercel/node";
import feedHandler from "../../api/instagram-feed";
import mediaHandler from "../../api/instagram-media";
import commentsHandler from "../../api/instagram-comments";
import profileHandler from "../../api/instagram-profile";
import {
  normalizeInstagramChild,
  normalizeInstagramComment,
  normalizeInstagramMedia,
  normalizeInstagramProfile,
} from "./instagram-shared";

// Fijan la normalización del media de Instagram (feed, children de carruseles,
// comentarios) y el manejo de errores del backend (token ausente, fallos de Meta,
// permisos, secretos). No cubren la UI.

const TOKEN = "IGAA-token-ficticio-de-prueba";

const IMG = "https://scontent.cdninstagram.com/v/foto.jpg";
const THUMB = "https://scontent.cdninstagram.com/v/miniatura.jpg";
const VIDEO_FILE = "https://scontent.cdninstagram.com/v/video.mp4";

function media(overrides: Record<string, unknown> = {}) {
  return {
    id: "1",
    media_type: "IMAGE",
    media_url: IMG,
    permalink: "https://www.instagram.com/p/AAA/",
    caption: "Hola",
    timestamp: "2026-09-18T19:00:31+0000",
    username: "upminaa",
    ...overrides,
  };
}

describe("normalizeInstagramMedia", () => {
  it("IMAGE: usa media_url y conserva los campos del contrato", () => {
    expect(normalizeInstagramMedia(media())).toEqual({
      id: "1",
      mediaType: "IMAGE",
      imageUrl: IMG,
      permalink: "https://www.instagram.com/p/AAA/",
      caption: "Hola",
      timestamp: "2026-09-18T19:00:31+00:00",
      username: "upminaa",
    });
  });

  it("VIDEO: imagen = thumbnail_url y el archivo de video va aparte en videoUrl", () => {
    const item = normalizeInstagramMedia(
      media({ media_type: "VIDEO", media_url: VIDEO_FILE, thumbnail_url: THUMB }),
    );
    expect(item?.mediaType).toBe("VIDEO");
    expect(item?.imageUrl).toBe(THUMB);
    expect(item?.videoUrl).toBe(VIDEO_FILE);
  });

  it("VIDEO sin thumbnail_url se descarta (media_url es un mp4)", () => {
    expect(
      normalizeInstagramMedia(media({ media_type: "VIDEO", media_url: VIDEO_FILE })),
    ).toBeNull();
  });

  it("CAROUSEL_ALBUM: usa media_url como portada y no tiene videoUrl", () => {
    const item = normalizeInstagramMedia(media({ media_type: "CAROUSEL_ALBUM" }));
    expect(item?.mediaType).toBe("CAROUSEL_ALBUM");
    expect(item?.imageUrl).toBe(IMG);
    expect(item?.videoUrl).toBeUndefined();
  });

  it("descarta media sin recursos válidos, sin permalink oficial o de tipo desconocido", () => {
    expect(normalizeInstagramMedia(media({ media_url: undefined }))).toBeNull();
    expect(
      normalizeInstagramMedia(media({ media_url: "javascript:alert(1)" })),
    ).toBeNull();
    expect(
      normalizeInstagramMedia(media({ media_url: "http://x.test/a.jpg" })),
    ).toBeNull();
    expect(normalizeInstagramMedia(media({ permalink: undefined }))).toBeNull();
    expect(
      normalizeInstagramMedia(media({ permalink: "https://evil.test/p/AAA/" })),
    ).toBeNull();
    expect(normalizeInstagramMedia(media({ media_type: "STORY" }))).toBeNull();
    expect(normalizeInstagramMedia(media({ id: undefined }))).toBeNull();
  });

  it("caption vacío o solo espacios queda como ausente", () => {
    expect(normalizeInstagramMedia(media({ caption: "   " }))?.caption).toBeUndefined();
  });

  it("timestamp: reescribe el offset de Meta a ISO 8601 y descarta fechas inválidas", () => {
    expect(normalizeInstagramMedia(media())?.timestamp).toBe("2026-09-18T19:00:31+00:00");
    expect(
      normalizeInstagramMedia(media({ timestamp: "2026-09-18T19:00:31-0500" }))
        ?.timestamp,
    ).toBe("2026-09-18T19:00:31-05:00");
    expect(normalizeInstagramMedia(media({ timestamp: "no-es-fecha" }))).toBeNull();
    expect(normalizeInstagramMedia(media({ timestamp: undefined }))).toBeNull();
  });

  it("likes y comentarios: solo se exponen si Meta los devuelve como enteros válidos", () => {
    const withCounts = normalizeInstagramMedia(
      media({ like_count: 14, comments_count: 0 }),
    );
    expect(withCounts?.likeCount).toBe(14);
    expect(withCounts?.commentsCount).toBe(0);

    const without = normalizeInstagramMedia(media());
    expect(without?.likeCount).toBeUndefined();
    expect(without?.commentsCount).toBeUndefined();

    const invalid = normalizeInstagramMedia(
      media({ like_count: -3, comments_count: "9" }),
    );
    expect(invalid?.likeCount).toBeUndefined();
    expect(invalid?.commentsCount).toBeUndefined();
  });

  it("productType: solo REELS o FEED cuando Meta lo devuelve, nunca deducido", () => {
    expect(
      normalizeInstagramMedia(media({ media_product_type: "REELS" }))?.productType,
    ).toBe("REELS");
    expect(
      normalizeInstagramMedia(media({ media_product_type: "FEED" }))?.productType,
    ).toBe("FEED");
    expect(
      normalizeInstagramMedia(media({ media_product_type: "AD" }))?.productType,
    ).toBe(undefined);
    // Un VIDEO sin media_product_type no se clasifica como Reel.
    expect(
      normalizeInstagramMedia(media({ media_type: "VIDEO", thumbnail_url: THUMB }))
        ?.productType,
    ).toBeUndefined();
  });
});

describe("normalizeInstagramChild", () => {
  it("IMAGE: usa media_url", () => {
    expect(
      normalizeInstagramChild({ id: "c1", media_type: "IMAGE", media_url: IMG }),
    ).toEqual({ id: "c1", mediaType: "IMAGE", imageUrl: IMG });
  });

  it("VIDEO: videoUrl + thumbnail como póster", () => {
    expect(
      normalizeInstagramChild({
        id: "c2",
        media_type: "VIDEO",
        media_url: VIDEO_FILE,
        thumbnail_url: THUMB,
      }),
    ).toEqual({ id: "c2", mediaType: "VIDEO", imageUrl: THUMB, videoUrl: VIDEO_FILE });
  });

  it("VIDEO con solo uno de los dos recursos se conserva; sin ninguno se descarta", () => {
    expect(
      normalizeInstagramChild({ id: "c3", media_type: "VIDEO", media_url: VIDEO_FILE }),
    ).toMatchObject({ videoUrl: VIDEO_FILE });
    expect(
      normalizeInstagramChild({ id: "c4", media_type: "VIDEO", thumbnail_url: THUMB }),
    ).toMatchObject({ imageUrl: THUMB });
    expect(normalizeInstagramChild({ id: "c5", media_type: "VIDEO" })).toBeNull();
  });

  it("descarta children sin recurso válido, sin id o de tipo desconocido", () => {
    expect(normalizeInstagramChild({ id: "c6", media_type: "IMAGE" })).toBeNull();
    expect(
      normalizeInstagramChild({
        id: "c7",
        media_type: "IMAGE",
        media_url: "http://x.test/a.jpg",
      }),
    ).toBeNull();
    expect(normalizeInstagramChild({ media_type: "IMAGE", media_url: IMG })).toBeNull();
    expect(
      normalizeInstagramChild({ id: "c8", media_type: "CAROUSEL_ALBUM", media_url: IMG }),
    ).toBeNull();
  });
});

describe("normalizeInstagramComment", () => {
  it("conserva id, texto, usuario y fecha ISO", () => {
    expect(
      normalizeInstagramComment({
        id: "k1",
        text: " Genial ",
        username: "fan",
        timestamp: "2026-09-19T10:00:00+0000",
        like_count: 4,
      }),
    ).toEqual({
      id: "k1",
      text: "Genial",
      username: "fan",
      timestamp: "2026-09-19T10:00:00+00:00",
      likeCount: 4,
    });
  });

  it("descarta comentarios sin id o sin texto", () => {
    expect(normalizeInstagramComment({ text: "hola" })).toBeNull();
    expect(normalizeInstagramComment({ id: "k2", text: "   " })).toBeNull();
    expect(normalizeInstagramComment({ id: "k3" })).toBeNull();
  });
});

// ---------- Handlers ----------

const getReq = (query: Record<string, string> = {}, method = "GET") =>
  ({ method, query }) as unknown as VercelRequest;

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

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

const metaError = (code: number, status = 400, type = "OAuthException") =>
  jsonResponse(
    { error: { message: `Detalle de Meta con ${TOKEN}`, type, code } },
    status,
  );

let errorSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.stubEnv("INSTAGRAM_ACCESS_TOKEN", TOKEN);
  errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const leaked = (state: { body?: unknown }) =>
  JSON.stringify([state.body, errorSpy.mock.calls]).includes(TOKEN);

const calledUrl = (fetchMock: ReturnType<typeof vi.fn>, call = 0) =>
  new URL((fetchMock.mock.calls[call] as unknown as [string])[0]);

describe("api/instagram-feed", () => {
  it("200: pide /me/media con el token, normaliza y descarta lo inutilizable", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({
        data: [
          media({ id: "img" }),
          media({
            id: "vid",
            media_type: "VIDEO",
            media_url: VIDEO_FILE,
            thumbnail_url: THUMB,
            media_product_type: "REELS",
            like_count: 5,
            comments_count: 2,
          }),
          media({ id: "car", media_type: "CAROUSEL_ALBUM" }),
          media({ id: "roto", media_url: undefined }),
        ],
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const { res, state } = mockRes();
    await feedHandler(getReq(), res);

    const url = calledUrl(fetchMock);
    expect(url.pathname).toBe("/me/media");
    expect(url.searchParams.get("access_token")).toBe(TOKEN);
    expect(url.searchParams.get("fields")).toContain("like_count");
    expect(url.searchParams.get("fields")).not.toMatch(/insights|children/);
    // Una sola petición a Meta: sin N+1 por post.
    expect(fetchMock).toHaveBeenCalledTimes(1);

    expect(state.status).toBe(200);
    const items = state.body as {
      id: string;
      likeCount?: number;
      productType?: string;
    }[];
    expect(items.map((i) => i.id)).toEqual(["img", "vid", "car"]);
    expect(items[1]).toMatchObject({ likeCount: 5, productType: "REELS" });
    expect(state.headers["Cache-Control"]).toMatch(/s-maxage/);
    expect(JSON.stringify(state.body)).not.toContain(TOKEN);
  });

  it("si Meta rechaza los campos extra, reintenta con los básicos y el feed sigue", async () => {
    const fetchMock = vi.fn(async (url: string) =>
      new URL(url).searchParams.get("fields")?.includes("like_count")
        ? metaError(100)
        : jsonResponse({ data: [media({ id: "img" })] }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const { res, state } = mockRes();
    await feedHandler(getReq(), res);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(state.status).toBe(200);
    expect(state.body as unknown[]).toHaveLength(1);
    expect(leaked(state)).toBe(false);
  });

  it("no reintenta si el rechazo es de token (190)", async () => {
    const fetchMock = vi.fn(async () => metaError(190));
    vi.stubGlobal("fetch", fetchMock);

    const { res, state } = mockRes();
    await feedHandler(getReq(), res);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(state.status).toBe(502);
  });

  it("200 con lista vacía cuando la cuenta no tiene publicaciones", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ data: [] })),
    );
    const { res, state } = mockRes();
    await feedHandler(getReq(), res);
    expect(state.status).toBe(200);
    expect(state.body).toEqual([]);
  });

  it("200 con lista vacía si Meta responde sin `data`", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({})),
    );
    const { res, state } = mockRes();
    await feedHandler(getReq(), res);
    expect(state.status).toBe(200);
    expect(state.body).toEqual([]);
  });

  it("503 sin llamar a Meta cuando falta INSTAGRAM_ACCESS_TOKEN", async () => {
    vi.stubEnv("INSTAGRAM_ACCESS_TOKEN", "");
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const { res, state } = mockRes();
    await feedHandler(getReq(), res);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(state.status).toBe(503);
    expect(state.body).toEqual({ error: "No se pudo obtener el feed de Instagram" });
  });

  it("502 genérico si Meta rechaza el token, sin filtrar mensaje ni token", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => metaError(190)),
    );

    const { res, state } = mockRes();
    await feedHandler(getReq(), res);

    expect(state.status).toBe(502);
    expect(state.body).toEqual({ error: "No se pudo obtener el feed de Instagram" });
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("HTTP 400 (OAuthException/190)"),
    );
    expect(leaked(state)).toBe(false);
  });

  it("502 si falla la red, sin filtrar la URL con el token", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError(
          `fetch failed: https://graph.instagram.com?access_token=${TOKEN}`,
        );
      }),
    );

    const { res, state } = mockRes();
    await feedHandler(getReq(), res);

    expect(state.status).toBe(502);
    expect(leaked(state)).toBe(false);
  });

  it("405 para métodos distintos de GET", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const { res, state } = mockRes();
    await feedHandler(getReq({}, "POST"), res);
    expect(state.status).toBe(405);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("api/instagram-media (children de carrusel)", () => {
  it("200: pide /{id}/children y devuelve IMAGE y VIDEO normalizados en orden", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({
        data: [
          { id: "c1", media_type: "IMAGE", media_url: IMG },
          {
            id: "c2",
            media_type: "VIDEO",
            media_url: VIDEO_FILE,
            thumbnail_url: THUMB,
          },
          { id: "c3", media_type: "IMAGE" }, // sin recurso: se descarta
        ],
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const { res, state } = mockRes();
    await mediaHandler(getReq({ id: "17848748789352011" }), res);

    const url = calledUrl(fetchMock);
    expect(url.pathname).toBe("/17848748789352011/children");
    expect(url.searchParams.get("access_token")).toBe(TOKEN);
    expect(state.status).toBe(200);
    expect(state.body).toEqual({
      children: [
        { id: "c1", mediaType: "IMAGE", imageUrl: IMG },
        { id: "c2", mediaType: "VIDEO", imageUrl: THUMB, videoUrl: VIDEO_FILE },
      ],
    });
    expect(state.headers["Cache-Control"]).toMatch(/s-maxage/);
    expect(leaked(state)).toBe(false);
  });

  it("200 con children vacío si Meta no devuelve data o ninguno es válido", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({})),
    );
    let r = mockRes();
    await mediaHandler(getReq({ id: "123" }), r.res);
    expect(r.state.body).toEqual({ children: [] });

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ data: [{ id: "x", media_type: "IMAGE" }] })),
    );
    r = mockRes();
    await mediaHandler(getReq({ id: "123" }), r.res);
    expect(r.state.body).toEqual({ children: [] });
  });

  it("400 sin llamar a Meta si el id no es numérico o falta", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    for (const query of [{ id: "../me" }, { id: "12 3" }, {}] as Record<
      string,
      string
    >[]) {
      const { res, state } = mockRes();
      await mediaHandler(getReq(query), res);
      expect(state.status).toBe(400);
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("405, 503 y 502 genéricos", async () => {
    const fetchMock = vi.fn(async () => metaError(190));
    vi.stubGlobal("fetch", fetchMock);

    let r = mockRes();
    await mediaHandler(getReq({ id: "1" }, "POST"), r.res);
    expect(r.state.status).toBe(405);

    r = mockRes();
    await mediaHandler(getReq({ id: "1" }), r.res);
    expect(r.state.status).toBe(502);
    expect(r.state.body).toEqual({
      error: "No se pudo obtener la publicación de Instagram",
    });
    expect(leaked(r.state)).toBe(false);

    vi.stubEnv("INSTAGRAM_ACCESS_TOKEN", "");
    r = mockRes();
    await mediaHandler(getReq({ id: "1" }), r.res);
    expect(r.state.status).toBe(503);
  });
});

describe("api/instagram-comments", () => {
  const insufficient = {
    error: "No se pueden leer los comentarios de esta publicación",
    reason: "insufficient_permission",
  };

  it("200: pide /{id}/comments y normaliza comentarios (con like_count si Meta lo da)", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({
        data: [
          {
            id: "k1",
            text: "Genial",
            username: "fan",
            timestamp: "2026-09-19T10:00:00+0000",
            like_count: 2,
          },
          { id: "k2", text: "" }, // sin texto: se descarta
        ],
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const { res, state } = mockRes();
    await commentsHandler(getReq({ id: "123" }), res);

    const url = calledUrl(fetchMock);
    expect(url.pathname).toBe("/123/comments");
    expect(url.searchParams.get("fields")).toContain("like_count");
    expect(state.status).toBe(200);
    expect(state.body).toEqual({
      comments: [
        {
          id: "k1",
          text: "Genial",
          username: "fan",
          timestamp: "2026-09-19T10:00:00+00:00",
          likeCount: 2,
        },
      ],
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(leaked(state)).toBe(false);
  });

  it("si Meta rechaza like_count del comentario, reintenta sin él", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      const fields = new URL(url).searchParams.get("fields") ?? "";
      return fields.includes("like_count")
        ? metaError(100)
        : jsonResponse({ data: [{ id: "k1", text: "Hola" }] });
    });
    vi.stubGlobal("fetch", fetchMock);

    const { res, state } = mockRes();
    await commentsHandler(getReq({ id: "123" }), res);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(state.status).toBe(200);
    expect(state.body).toEqual({ comments: [{ id: "k1", text: "Hola" }] });
  });

  it("HTTP 200 con data:[] → 200 con lista vacía; NO se interpreta como falta de permisos", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ data: [] }));
    vi.stubGlobal("fetch", fetchMock);

    const { res, state } = mockRes();
    await commentsHandler(getReq({ id: "123" }), res);

    expect(state.status).toBe(200);
    expect(state.body).toEqual({ comments: [] });
    // Una sola llamada a Meta: ya no se consulta comments_count para "adivinar" permisos.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    // Nada sobre permisos en logs ni respuesta.
    expect(JSON.stringify([state.body, errorSpy.mock.calls])).not.toMatch(
      /manage_comments|permission/i,
    );
  });

  it("respuesta sin `data` → 200 con lista vacía", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({})),
    );
    const { res, state } = mockRes();
    await commentsHandler(getReq({ id: "123" }), res);
    expect(state.status).toBe(200);
    expect(state.body).toEqual({ comments: [] });
  });

  it("error EXPLÍCITO de permisos de Meta (código 10) → 403 insufficient_permission", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => metaError(10, 400)),
    );

    const { res, state } = mockRes();
    await commentsHandler(getReq({ id: "123" }), res);

    expect(state.status).toBe(403);
    expect(state.body).toMatchObject(insufficient);
    expect(leaked(state)).toBe(false);
  });

  it("el diagnóstico (debug) del 403 solo se devuelve fuera de producción, saneado", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => metaError(10, 400)),
    );

    let r = mockRes();
    await commentsHandler(getReq({ id: "123" }), r.res);
    expect(r.state.body).toHaveProperty("debug");
    expect(leaked(r.state)).toBe(false);

    vi.stubEnv("VERCEL_ENV", "production");
    r = mockRes();
    await commentsHandler(getReq({ id: "123" }), r.res);
    expect(r.state.status).toBe(403);
    expect(r.state.body).not.toHaveProperty("debug");
  });

  it("error real de Meta (token 190, HTTP 500, red) → 502 genérico, sin filtrar el token", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => metaError(190)),
    );
    let r = mockRes();
    await commentsHandler(getReq({ id: "123" }), r.res);
    expect(r.state.status).toBe(502);
    expect(r.state.body).toEqual({
      error: "No se pudieron obtener los comentarios de Instagram",
    });
    expect(leaked(r.state)).toBe(false);

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({}, 500)),
    );
    r = mockRes();
    await commentsHandler(getReq({ id: "123" }), r.res);
    expect(r.state.status).toBe(502);

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError(`fetch failed ?access_token=${TOKEN}`);
      }),
    );
    r = mockRes();
    await commentsHandler(getReq({ id: "123" }), r.res);
    expect(r.state.status).toBe(502);
    expect(leaked(r.state)).toBe(false);
  });

  it("400 con id no válido, 405 con POST y 503 sin token, sin llamar a Meta", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    let r = mockRes();
    await commentsHandler(getReq({ id: "abc" }), r.res);
    expect(r.state.status).toBe(400);

    r = mockRes();
    await commentsHandler(getReq({ id: "1" }, "POST"), r.res);
    expect(r.state.status).toBe(405);

    vi.stubEnv("INSTAGRAM_ACCESS_TOKEN", "");
    r = mockRes();
    await commentsHandler(getReq({ id: "1" }), r.res);
    expect(r.state.status).toBe(503);

    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("normalizeInstagramProfile", () => {
  it("conserva username y foto https", () => {
    expect(
      normalizeInstagramProfile({ username: "upminaa", profile_picture_url: IMG }),
    ).toEqual({ username: "upminaa", profilePictureUrl: IMG });
  });

  it("sin foto, con foto no https o vacía → sin profilePictureUrl", () => {
    expect(
      normalizeInstagramProfile({ username: "u" }).profilePictureUrl,
    ).toBeUndefined();
    expect(
      normalizeInstagramProfile({
        username: "u",
        profile_picture_url: "http://x.test/a.jpg",
      }).profilePictureUrl,
    ).toBeUndefined();
    expect(
      normalizeInstagramProfile({
        username: "u",
        profile_picture_url: "javascript:alert(1)",
      }).profilePictureUrl,
    ).toBeUndefined();
    expect(normalizeInstagramProfile({}).username).toBeUndefined();
  });
});

describe("api/instagram-profile", () => {
  it("200: pide /me con username y profile_picture_url y devuelve el perfil normalizado", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({ username: "upminaa", profile_picture_url: IMG, id: "999" }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const { res, state } = mockRes();
    await profileHandler(getReq(), res);

    const url = calledUrl(fetchMock);
    expect(url.pathname).toBe("/me");
    expect(url.searchParams.get("fields")).toBe("username,profile_picture_url");
    expect(url.searchParams.get("access_token")).toBe(TOKEN);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(state.status).toBe(200);
    // Solo el contrato: no se reenvían campos extra de Meta.
    expect(state.body).toEqual({ username: "upminaa", profilePictureUrl: IMG });
    expect(state.headers["Cache-Control"]).toMatch(/s-maxage=3600/);
    expect(JSON.stringify(state.body)).not.toContain(TOKEN);
  });

  it("Meta no devuelve foto → 200 solo con username (el frontend usa el fallback)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ username: "upminaa" })),
    );
    const { res, state } = mockRes();
    await profileHandler(getReq(), res);
    expect(state.status).toBe(200);
    expect(state.body).toEqual({ username: "upminaa" });
  });

  it("si Meta rechaza profile_picture_url, reintenta solo con username", async () => {
    const fetchMock = vi.fn(async (url: string) =>
      new URL(url).searchParams.get("fields")?.includes("profile_picture_url")
        ? metaError(100)
        : jsonResponse({ username: "upminaa" }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const { res, state } = mockRes();
    await profileHandler(getReq(), res);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(state.status).toBe(200);
    expect(state.body).toEqual({ username: "upminaa" });
    expect(leaked(state)).toBe(false);
  });

  it("502 genérico si Meta rechaza el token y 503 sin token, sin filtrar el token", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => metaError(190)),
    );
    let r = mockRes();
    await profileHandler(getReq(), r.res);
    expect(r.state.status).toBe(502);
    expect(r.state.body).toEqual({ error: "No se pudo obtener el perfil de Instagram" });
    expect(leaked(r.state)).toBe(false);

    vi.stubEnv("INSTAGRAM_ACCESS_TOKEN", "");
    r = mockRes();
    await profileHandler(getReq(), r.res);
    expect(r.state.status).toBe(503);
  });

  it("405 para métodos distintos de GET", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const { res, state } = mockRes();
    await profileHandler(getReq({}, "POST"), res);
    expect(state.status).toBe(405);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("timeout de 10 s en las llamadas a Meta", () => {
  // AbortSignal.timeout usa temporizadores internos que vi.useFakeTimers no controla: se sustituye
  // por una señal manejable y se comprueba el valor con el que se crea.
  function controllableTimeout() {
    const controller = new AbortController();
    const spy = vi.spyOn(AbortSignal, "timeout").mockReturnValue(controller.signal);
    const fire = () =>
      controller.abort(
        new DOMException(`superado el tiempo con ${TOKEN}`, "TimeoutError"),
      );
    return { spy, fire };
  }

  // fetch que nunca responde hasta que se aborta su señal (como una conexión colgada).
  const hangingFetch = () =>
    vi.fn(
      (_url: string, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
        }),
    );

  it("cada operación (feed, children, comentarios y perfil) usa un timeout de exactamente 10 s", async () => {
    const spy = vi.spyOn(AbortSignal, "timeout");
    const fetchMock = vi.fn(async () => jsonResponse({ data: [] }));
    vi.stubGlobal("fetch", fetchMock);

    await feedHandler(getReq(), mockRes().res);
    await mediaHandler(getReq({ id: "123" }), mockRes().res);
    await commentsHandler(getReq({ id: "123" }), mockRes().res);
    await profileHandler(getReq(), mockRes().res);

    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(spy).toHaveBeenCalledTimes(4);
    for (const call of spy.mock.calls) expect(call).toEqual([10_000]);
    for (const call of fetchMock.mock.calls as unknown as [string, RequestInit][]) {
      expect(call[1].signal).toBeInstanceOf(AbortSignal);
    }
  });

  it("si Meta no responde, el feed acaba en 502 con el mismo contrato y sin filtrar el token", async () => {
    const { fire } = controllableTimeout();
    vi.stubGlobal("fetch", hangingFetch());

    const { res, state } = mockRes();
    const pending = feedHandler(getReq(), res);
    fire();
    await pending;

    expect(state.status).toBe(502);
    expect(state.body).toEqual({ error: "No se pudo obtener el feed de Instagram" });
    expect(errorSpy).toHaveBeenCalledWith(
      "[instagram-feed] Instagram media: tiempo de espera agotado (10 s)",
    );
    expect(leaked(state)).toBe(false);
  });

  it("también si el cuerpo de la respuesta se queda colgado", async () => {
    const { fire } = controllableTimeout();
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          ({
            ok: true,
            status: 200,
            json: () =>
              Promise.reject(new DOMException(`cuerpo colgado ${TOKEN}`, "TimeoutError")),
          }) as unknown as Response,
      ),
    );

    const { res, state } = mockRes();
    fire();
    await profileHandler(getReq(), res);

    expect(state.status).toBe(502);
    expect(state.body).toEqual({ error: "No se pudo obtener el perfil de Instagram" });
    expect(errorSpy).toHaveBeenCalledWith(
      "[instagram-profile] Instagram profile: tiempo de espera agotado (10 s)",
    );
    expect(leaked(state)).toBe(false);
  });

  it("en comentarios un timeout es un fallo del proveedor (502), no de permisos (403), y no se reintenta", async () => {
    const { fire } = controllableTimeout();
    const fetchMock = hangingFetch();
    vi.stubGlobal("fetch", fetchMock);

    const { res, state } = mockRes();
    const pending = commentsHandler(getReq({ id: "17900000000000001" }), res);
    fire();
    await pending;

    expect(state.status).toBe(502);
    expect(state.body).toEqual({
      error: "No se pudieron obtener los comentarios de Instagram",
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(leaked(state)).toBe(false);
  });

  it("children de un carrusel: mismo tratamiento (502 saneado)", async () => {
    const { fire } = controllableTimeout();
    vi.stubGlobal("fetch", hangingFetch());

    const { res, state } = mockRes();
    const pending = mediaHandler(getReq({ id: "17900000000000001" }), res);
    fire();
    await pending;

    expect(state.status).toBe(502);
    expect(state.body).toEqual({
      error: "No se pudo obtener la publicación de Instagram",
    });
    expect(leaked(state)).toBe(false);
  });

  it("una respuesta normal no se ve afectada: sin aviso de timeout en los logs", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ data: [media({ id: "ok" })] })),
    );

    const { res, state } = mockRes();
    await feedHandler(getReq(), res);

    expect(state.status).toBe(200);
    expect(errorSpy).not.toHaveBeenCalled();
  });
});
