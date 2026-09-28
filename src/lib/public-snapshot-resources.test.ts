import { describe, expect, it } from "vitest";
import {
  MAX_SOURCE_ID_LENGTH,
  SNAPSHOT_DEFINITIONS,
  SNAPSHOT_MAX_AGE_MS,
  SNAPSHOT_RESOURCES,
  decodeSnapshotPayload,
  encodeSnapshotPayload,
  isSnapshotResource,
  isSourceIdOf,
  snapshotMaxAgeMs,
  snapshotProvider,
  socialSnapshotResources,
  socialSourceId,
  twitchSourceId,
  youtubeSourceId,
  type SnapshotResource,
} from "./public-snapshot-resources";
import { validPayload } from "./public-snapshot-fixtures";

// Recursos, edades, identidad de la fuente y validadores estrictos de los snapshots públicos
// (Fase 9H-4, checkpoint 2). Todo puro: sin Supabase.

const HOUR = 3_600_000;

describe("recursos canónicos", () => {
  it("son exactamente los 8 previstos, en este orden", () => {
    expect([...SNAPSHOT_RESOURCES]).toEqual([
      "twitch-clips",
      "twitch-latest-video",
      "youtube-latest",
      "youtube-videos",
      "youtube-shorts",
      "instagram-feed",
      "instagram-profile",
      "tiktok-videos",
    ]);
    expect(Object.keys(SNAPSHOT_DEFINITIONS).sort()).toEqual(
      [...SNAPSHOT_RESOURCES].sort(),
    );
  });

  it("twitch-status NO es un recurso: ni en tipos ni en ejecución", () => {
    // @ts-expect-error twitch-status no es un SnapshotResource (no hay forma de persistirlo).
    const asResource: SnapshotResource = "twitch-status";
    expect(isSnapshotResource(asResource)).toBe(false);
    expect(SNAPSHOT_RESOURCES).not.toContain("twitch-status");
    expect(Object.keys(SNAPSHOT_DEFINITIONS)).not.toContain("twitch-status");
  });

  it("instagram-media e instagram-comments tampoco existen", () => {
    for (const name of [
      "instagram-media",
      "instagram-comments",
      "twitch-status",
      "",
      "__proto__",
      "constructor",
    ]) {
      expect(isSnapshotResource(name)).toBe(false);
    }
    for (const bad of [null, undefined, 1, {}, ["twitch-clips"]]) {
      expect(isSnapshotResource(bad)).toBe(false);
    }
  });

  it("cada recurso pertenece a su proveedor", () => {
    expect(snapshotProvider("twitch-clips")).toBe("twitch");
    expect(snapshotProvider("twitch-latest-video")).toBe("twitch");
    expect(snapshotProvider("youtube-latest")).toBe("youtube");
    expect(snapshotProvider("youtube-videos")).toBe("youtube");
    expect(snapshotProvider("youtube-shorts")).toBe("youtube");
    expect(snapshotProvider("instagram-feed")).toBe("instagram");
    expect(snapshotProvider("instagram-profile")).toBe("instagram");
    expect(snapshotProvider("tiktok-videos")).toBe("tiktok");
  });

  it("los recursos sociales de cada red son solo los suyos", () => {
    expect(socialSnapshotResources("instagram")).toEqual([
      "instagram-feed",
      "instagram-profile",
    ]);
    expect(socialSnapshotResources("tiktok")).toEqual(["tiktok-videos"]);
  });
});

describe("edades máximas", () => {
  it("48 h para contenido duradero y 24 h para redes sociales (constantes centralizadas)", () => {
    expect(SNAPSHOT_MAX_AGE_MS.durable).toBe(48 * HOUR);
    expect(SNAPSHOT_MAX_AGE_MS.social).toBe(24 * HOUR);
  });

  it.each([
    "twitch-clips",
    "twitch-latest-video",
    "youtube-latest",
    "youtube-videos",
    "youtube-shorts",
  ] as const)("%s → 48 h", (resource) => {
    expect(snapshotMaxAgeMs(resource)).toBe(48 * HOUR);
  });

  it.each(["instagram-feed", "instagram-profile", "tiktok-videos"] as const)(
    "%s → 24 h",
    (resource) => {
      expect(snapshotMaxAgeMs(resource)).toBe(24 * HOUR);
    },
  );
});

describe("source_id", () => {
  const CONNECTION = "0b8e5f5e-1c2d-4e5f-8a9b-0c1d2e3f4a5b";

  it("Twitch: login del canal en minúsculas; inválido → undefined", () => {
    expect(twitchSourceId("upminaa")).toBe("twitch:upminaa");
    expect(twitchSourceId("  UpMinaa ")).toBe("twitch:upminaa");
    for (const bad of [
      "",
      "a b",
      "x".repeat(26),
      "canal:otro",
      "ñandú",
      undefined,
      null,
      5,
    ]) {
      expect(twitchSourceId(bad)).toBeUndefined();
    }
  });

  it("YouTube: id de canal UC + 22 caracteres; inválido → undefined", () => {
    expect(youtubeSourceId("UCabcdefghijklmnopqrstuv")).toBe(
      "youtube:UCabcdefghijklmnopqrstuv",
    );
    for (const bad of [
      "",
      "abcdefghijklmnopqrstuvwx",
      "UCcorto",
      "UC" + "a".repeat(23),
      undefined,
      7,
    ]) {
      expect(youtubeSourceId(bad)).toBeUndefined();
    }
  });

  it("redes sociales: provider:<id de conexión>:<provider_user_id>, inequívoco y acotado", () => {
    const id = socialSourceId("tiktok", CONNECTION, "open-id_01.~");
    expect(id).toBe(`tiktok:${CONNECTION}:open-id_01.~`);
    expect(socialSourceId("instagram", CONNECTION.toUpperCase(), "1789")).toBe(
      `instagram:${CONNECTION}:1789`,
    );
    expect(id && id.length).toBeLessThanOrEqual(MAX_SOURCE_ID_LENGTH);
  });

  it("una conexión o una cuenta distintas producen otro source_id", () => {
    const other = "1b8e5f5e-1c2d-4e5f-8a9b-0c1d2e3f4a5b";
    const a = socialSourceId("tiktok", CONNECTION, "user1");
    expect(socialSourceId("tiktok", other, "user1")).not.toBe(a);
    expect(socialSourceId("tiktok", CONNECTION, "user2")).not.toBe(a);
    expect(socialSourceId("instagram", CONNECTION, "user1")).not.toBe(a);
  });

  it("rechaza componentes mal formados (uuid, ':' en el usuario, espacios, vacío, demasiado largo)", () => {
    for (const [conn, user] of [
      ["no-es-uuid", "user"],
      [CONNECTION, ""],
      [CONNECTION, "a:b"],
      [CONNECTION, "con espacio"],
      [CONNECTION, "x".repeat(129)],
      [CONNECTION, "ñ"],
      [undefined, "user"],
      [CONNECTION, undefined],
    ] as const) {
      expect(socialSourceId("tiktok", conn, user)).toBeUndefined();
    }
    // @ts-expect-error un proveedor que no es social no tiene source_id de conexión.
    expect(socialSourceId("twitch", CONNECTION, "user")).toBeUndefined();
  });

  it("isSourceIdOf comprueba proveedor y forma (defensa ante un cast)", () => {
    expect(isSourceIdOf("twitch", "twitch:upminaa")).toBe(true);
    expect(isSourceIdOf("twitch", "youtube:UCabcdefghijklmnopqrstuv")).toBe(false);
    expect(isSourceIdOf("youtube", "youtube:UCabcdefghijklmnopqrstuv")).toBe(true);
    expect(isSourceIdOf("tiktok", `tiktok:${CONNECTION}:u1`)).toBe(true);
    expect(isSourceIdOf("instagram", `tiktok:${CONNECTION}:u1`)).toBe(false);
    expect(isSourceIdOf("tiktok", "tiktok:sin-uuid:u1")).toBe(false);
    expect(isSourceIdOf("tiktok", `tiktok:${CONNECTION}:`)).toBe(false);
    expect(isSourceIdOf("twitch", `twitch:${"a".repeat(300)}`)).toBe(false);
    expect(isSourceIdOf("twitch", 5)).toBe(false);
  });
});

describe("validadores: valores válidos", () => {
  it.each(SNAPSHOT_RESOURCES.map((r) => [r]))(
    "%s: el valor de ejemplo se acepta y sobrevive al ciclo codificar → decodificar",
    (resource) => {
      const value = validPayload(resource);
      const stored = encodeSnapshotPayload(resource, value);
      expect(stored).toBeDefined();
      expect(decodeSnapshotPayload(resource, stored)?.value).toEqual(value);
    },
  );

  it("los payloads almacenables son objetos o arrays JSON (nunca un escalar)", () => {
    for (const resource of SNAPSHOT_RESOURCES) {
      const stored = encodeSnapshotPayload(resource, validPayload(resource));
      expect(typeof stored).toBe("object");
      expect(stored).not.toBeNull();
    }
  });

  it("una lista VACÍA es un vacío válido en los recursos de lista", () => {
    for (const resource of [
      "twitch-clips",
      "youtube-videos",
      "youtube-shorts",
      "instagram-feed",
      "tiktok-videos",
    ] as const) {
      expect(encodeSnapshotPayload(resource, [])).toEqual([]);
      expect(decodeSnapshotPayload(resource, [])?.value).toEqual([]);
    }
  });

  it("el vacío válido de un recurso de un solo elemento es null (marca almacenada, no NULL de SQL)", () => {
    for (const resource of ["twitch-latest-video", "youtube-latest"] as const) {
      const stored = encodeSnapshotPayload(resource, null);
      expect(stored).toEqual({ empty: true });
      expect(decodeSnapshotPayload(resource, stored)?.value).toBeNull();
    }
  });

  it("un perfil vacío `{}` es un perfil de forma válida (Meta no devolvió campos opcionales)", () => {
    expect(encodeSnapshotPayload("instagram-profile", {})).toEqual({});
    expect(encodeSnapshotPayload("instagram-profile", { username: undefined })).toEqual(
      {},
    );
  });

  it("los campos undefined (como los deja un normalizador) cuentan como ausentes", () => {
    const post = {
      ...validPayload("instagram-feed")[0],
      videoUrl: undefined,
      caption: undefined,
    };
    expect(encodeSnapshotPayload("instagram-feed", [post])).toBeDefined();
  });

  it("la miniatura de YouTube puede faltar", () => {
    const video = { ...validPayload("youtube-latest"), thumbnailUrl: undefined };
    expect(encodeSnapshotPayload("youtube-latest", video)).toBeDefined();
  });
});

describe("validadores: vacío válido ≠ respuesta mal formada", () => {
  const LIST_RESOURCES = [
    "twitch-clips",
    "youtube-videos",
    "youtube-shorts",
    "instagram-feed",
    "tiktok-videos",
  ] as const;

  it("un contenedor equivocado NO se convierte en vacío (lista)", () => {
    for (const resource of LIST_RESOURCES) {
      for (const bad of [
        undefined,
        null,
        {},
        { data: [] },
        "hello",
        "",
        0,
        5,
        true,
        { data: "hello" },
        { empty: true },
      ]) {
        expect(encodeSnapshotPayload(resource, bad)).toBeUndefined();
        expect(decodeSnapshotPayload(resource, bad)).toBeUndefined();
      }
    }
  });

  it("el vacío de un solo elemento no puede ser [], {}, un texto ni un valor cualquiera", () => {
    for (const resource of ["twitch-latest-video", "youtube-latest"] as const) {
      for (const bad of [
        undefined,
        [],
        {},
        "",
        "hello",
        0,
        { empty: false },
        { empty: 1 },
        { empty: true, extra: 1 },
      ]) {
        expect(encodeSnapshotPayload(resource, bad)).toBeUndefined();
        expect(decodeSnapshotPayload(resource, bad)).toBeUndefined();
      }
    }
  });

  it("null solo es válido donde existe el vacío de un solo elemento", () => {
    for (const resource of [...LIST_RESOURCES, "instagram-profile"] as const) {
      expect(encodeSnapshotPayload(resource, null)).toBeUndefined();
    }
  });

  it("el perfil no admite contenedores equivocados", () => {
    for (const bad of [undefined, null, [], "hello", 5, { username: 5 }]) {
      expect(encodeSnapshotPayload("instagram-profile", bad)).toBeUndefined();
    }
  });

  it("una lista con demasiados elementos se rechaza", () => {
    expect(
      encodeSnapshotPayload(
        "twitch-clips",
        Array(13).fill(validPayload("twitch-clips")[0]),
      ),
    ).toBeUndefined();
    expect(
      encodeSnapshotPayload(
        "youtube-shorts",
        Array(25).fill(validPayload("youtube-shorts")[0]),
      ),
    ).toBeUndefined();
    expect(
      encodeSnapshotPayload(
        "tiktok-videos",
        Array(13).fill(validPayload("tiktok-videos")[0]),
      ),
    ).toBeUndefined();
    expect(
      encodeSnapshotPayload(
        "instagram-feed",
        Array(25).fill(validPayload("instagram-feed")[0]),
      ),
    ).toBeUndefined();
  });
});

describe("validadores: URLs inseguras", () => {
  const UNSAFE = [
    "javascript:alert(1)",
    "data:text/html,<script>alert(1)</script>",
    "blob:https://x.test/uuid",
    "http://static-cdn.jtvnw.net/a.jpg",
    "//static-cdn.jtvnw.net/a.jpg",
    "https://evil.test/a.jpg",
    "https://static-cdn.jtvnw.net.evil.test/a.jpg",
    "https://user:pass@static-cdn.jtvnw.net/a.jpg",
    "https://static-cdn.jtvnw.net/a b.jpg",
    "https://static-cdn.jtvnw.net/\nx.jpg",
    "no es una url",
    "",
  ];

  it("miniatura de un clip de Twitch", () => {
    for (const url of UNSAFE) {
      const clip = { ...validPayload("twitch-clips")[0], thumbnailUrl: url };
      expect(encodeSnapshotPayload("twitch-clips", [clip])).toBeUndefined();
    }
  });

  it("enlace y embed del clip: solo https de twitch.tv y clips.twitch.tv", () => {
    const base = validPayload("twitch-clips")[0];
    expect(
      encodeSnapshotPayload("twitch-clips", [{ ...base, url: "https://evil.test/clip" }]),
    ).toBeUndefined();
    expect(
      encodeSnapshotPayload("twitch-clips", [
        { ...base, embedUrl: "https://www.twitch.tv/embed" },
      ]),
    ).toBeUndefined();
    expect(
      encodeSnapshotPayload("twitch-clips", [
        { ...base, embedUrl: "http://clips.twitch.tv/embed?clip=x" },
      ]),
    ).toBeUndefined();
    expect(
      encodeSnapshotPayload("twitch-clips", [
        { ...base, embedUrl: "javascript:alert(1)" },
      ]),
    ).toBeUndefined();
  });

  it("portada de YouTube, foto de Instagram, portada de TikTok y enlaces de publicación", () => {
    for (const url of UNSAFE) {
      expect(
        encodeSnapshotPayload("youtube-latest", {
          ...validPayload("youtube-latest"),
          thumbnailUrl: url,
        }),
      ).toBeUndefined();
      expect(
        encodeSnapshotPayload("instagram-feed", [
          { ...validPayload("instagram-feed")[0], imageUrl: url },
        ]),
      ).toBeUndefined();
      expect(
        encodeSnapshotPayload("instagram-profile", { profilePictureUrl: url }),
      ).toBeUndefined();
      expect(
        encodeSnapshotPayload("tiktok-videos", [
          { ...validPayload("tiktok-videos")[0], coverImageUrl: url },
        ]),
      ).toBeUndefined();
      expect(
        encodeSnapshotPayload("tiktok-videos", [
          { ...validPayload("tiktok-videos")[0], embedUrl: url },
        ]),
      ).toBeUndefined();
      expect(
        encodeSnapshotPayload("instagram-feed", [
          { ...validPayload("instagram-feed")[0], permalink: url },
        ]),
      ).toBeUndefined();
    }
  });

  it("el permalink de Instagram debe ser de instagram.com y el vídeo de un CDN permitido", () => {
    const post = validPayload("instagram-feed")[1];
    expect(post.mediaType).toBe("VIDEO");
    expect(
      encodeSnapshotPayload("instagram-feed", [
        { ...post, permalink: "https://evil.test/p/1/" },
      ]),
    ).toBeUndefined();
    expect(
      encodeSnapshotPayload("instagram-feed", [
        { ...post, videoUrl: "https://evil.test/v.mp4" },
      ]),
    ).toBeUndefined();
    expect(
      encodeSnapshotPayload("instagram-feed", [
        { ...post, videoUrl: "http://scontent.cdninstagram.com/v.mp4" },
      ]),
    ).toBeUndefined();
  });

  it("una URL demasiado larga se rechaza", () => {
    const long = `https://static-cdn.jtvnw.net/${"a".repeat(2100)}.jpg`;
    expect(
      encodeSnapshotPayload("twitch-clips", [
        { ...validPayload("twitch-clips")[0], thumbnailUrl: long },
      ]),
    ).toBeUndefined();
  });

  it("no se sobre-restringe: subdominios reales de los CDN actuales se aceptan", () => {
    const ig = validPayload("instagram-feed")[0];
    for (const host of [
      "scontent-iad3-2.cdninstagram.com",
      "scontent.xx.fbcdn.net",
      "www.instagram.com",
    ]) {
      expect(
        encodeSnapshotPayload("instagram-feed", [
          { ...ig, imageUrl: `https://${host}/v/t51/a.jpg?oe=6A2C3D4E&x=y` },
        ]),
      ).toBeDefined();
    }
    const tt = validPayload("tiktok-videos")[0];
    for (const host of ["p16-common-sign.tiktokcdn.com", "p19-sign.tiktokcdn-us.com"]) {
      expect(
        encodeSnapshotPayload("tiktok-videos", [
          { ...tt, coverImageUrl: `https://${host}/x.jpeg?x-expires=1&x-signature=abc` },
        ]),
      ).toBeDefined();
    }
    expect(
      encodeSnapshotPayload("tiktok-videos", [
        { ...tt, embedUrl: "https://vm.tiktok.com/ZMabc123/" },
      ]),
    ).toBeDefined();
  });
});

describe("validadores: contenido no permitido", () => {
  it("una clave desconocida se RECHAZA (nada de campos de más ni respuestas crudas)", () => {
    const clip = validPayload("twitch-clips")[0];
    for (const extra of [
      { access_token: "abc" },
      { refresh_token: "abc" },
      { Authorization: "Bearer abc" },
      { client_secret: "abc" },
      { raw: { data: [] } },
      { cookie: "a=b" },
      { service_role: "k" },
      { __proto__x: 1 },
    ]) {
      expect(
        encodeSnapshotPayload("twitch-clips", [{ ...clip, ...extra }]),
      ).toBeUndefined();
    }
    expect(
      encodeSnapshotPayload("instagram-profile", { username: "u", access_token: "t" }),
    ).toBeUndefined();
    expect(
      encodeSnapshotPayload("twitch-latest-video", {
        ...validPayload("twitch-latest-video"),
        refresh_token: "t",
      }),
    ).toBeUndefined();
  });

  it("una respuesta cruda de un proveedor no valida como snapshot", () => {
    const raw = { data: [{ id: "1", user_id: "2", token: "t" }], pagination: {} };
    for (const resource of SNAPSHOT_RESOURCES) {
      expect(encodeSnapshotPayload(resource, raw)).toBeUndefined();
    }
  });

  it("el valor reconstruido solo contiene campos conocidos", () => {
    const stored = encodeSnapshotPayload(
      "tiktok-videos",
      validPayload("tiktok-videos"),
    ) as Record<string, unknown>[];
    expect(Object.keys(stored[0]).sort()).toEqual([
      "coverImageUrl",
      "createTime",
      "embedUrl",
      "id",
      "title",
    ]);
  });

  it("ids, fechas, números y textos irrazonables se rechazan", () => {
    const clip = validPayload("twitch-clips")[0];
    for (const patch of [
      { id: "" },
      { id: "con espacios" },
      { id: "x".repeat(101) },
      { id: 5 },
      { createdAt: "ayer" },
      { createdAt: "2026-13-45T99:00:00Z" },
      { viewCount: -1 },
      { viewCount: 1.5 },
      { viewCount: "7" },
      { title: "x".repeat(301) },
      { title: "con \u0000 nulo" },
      { creatorName: 7 },
    ]) {
      expect(
        encodeSnapshotPayload("twitch-clips", [{ ...clip, ...patch }]),
      ).toBeUndefined();
    }
    const yt = validPayload("youtube-latest");
    for (const patch of [
      { id: "corto" },
      { duration: "12" },
      { duration: "1:2:3" },
      { description: "x".repeat(10_001) },
      { publishedAt: "" },
    ]) {
      expect(
        encodeSnapshotPayload("youtube-latest", { ...yt, ...patch }),
      ).toBeUndefined();
    }
  });

  it("los saltos de línea y tabuladores legítimos de un texto se conservan", () => {
    const yt = {
      ...validPayload("youtube-latest"),
      description: "línea 1\nlínea 2\t\r\nfin",
    };
    expect(encodeSnapshotPayload("youtube-latest", yt)).toBeDefined();
  });

  it("Instagram: tipos y campos coherentes", () => {
    const post = validPayload("instagram-feed")[0];
    for (const patch of [
      { mediaType: "STORY" },
      { productType: "REEL" },
      { likeCount: -1 },
      { username: "" },
      { videoUrl: "https://scontent.cdninstagram.com/v.mp4" }, // solo un VIDEO lleva videoUrl
    ]) {
      expect(
        encodeSnapshotPayload("instagram-feed", [{ ...post, ...patch }]),
      ).toBeUndefined();
    }
  });

  it("Instagram: productType aceptado (FEED/REELS) sobrevive la normalización; ausente también", () => {
    const post = validPayload("instagram-feed")[0];
    for (const productType of ["FEED", "REELS"] as const) {
      const stored = encodeSnapshotPayload("instagram-feed", [
        { ...post, productType },
      ]) as Record<string, unknown>[];
      expect(stored[0].productType).toBe(productType);
      expect(decodeSnapshotPayload("instagram-feed", stored)).toBeDefined();
    }
    // El fixture base no trae productType: debe seguir aceptándose como ausente (no se inventa).
    expect(post).not.toHaveProperty("productType");
    const storedWithout = encodeSnapshotPayload("instagram-feed", [post]) as Record<
      string,
      unknown
    >[];
    expect(storedWithout[0]).not.toHaveProperty("productType");
  });

  it("Instagram: un productType inválido no llega a InstagramMediaItem", () => {
    const post = validPayload("instagram-feed")[0];
    for (const invalid of ["REEL", "feed", "STORY", 1, true, null]) {
      expect(
        encodeSnapshotPayload("instagram-feed", [{ ...post, productType: invalid }]),
      ).toBeUndefined();
    }
  });

  it("el HTML/script dentro de un texto no se ejecuta ni se elimina: es texto (React lo escapa)", () => {
    const yt = { ...validPayload("youtube-latest"), title: "<script>alert(1)</script>" };
    const stored = encodeSnapshotPayload("youtube-latest", yt) as { title: string };
    expect(stored.title).toBe("<script>alert(1)</script>");
  });
});

describe("decodificar (lectura): no se confía en la fila", () => {
  it("un payload guardado que ya no valida se ignora", () => {
    const stored = encodeSnapshotPayload(
      "twitch-clips",
      validPayload("twitch-clips"),
    ) as Record<string, unknown>[];
    stored[0].thumbnailUrl = "javascript:alert(1)";
    expect(decodeSnapshotPayload("twitch-clips", stored)).toBeUndefined();
  });

  it("un payload con campos añadidos por otra vía se ignora", () => {
    const stored = encodeSnapshotPayload(
      "tiktok-videos",
      validPayload("tiktok-videos"),
    ) as Record<string, unknown>[];
    stored[0].access_token = "x";
    expect(decodeSnapshotPayload("tiktok-videos", stored)).toBeUndefined();
  });
});
