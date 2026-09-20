/** Solo se enlaza a URLs https de tiktok.com (o subdominios como vm.tiktok.com). */
export function safeTikTokUrl(value: string): string | undefined {
  try {
    const url = new URL(value);
    const isTikTok =
      url.hostname === "tiktok.com" || url.hostname.endsWith(".tiktok.com");
    return url.protocol === "https:" && isTikTok ? url.href : undefined;
  } catch {
    return undefined;
  }
}
