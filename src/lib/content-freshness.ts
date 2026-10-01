import type { QueryClient } from "@tanstack/react-query";

type Domain = "community" | "cosplay";
// One token per domain/client, outside query identities. Survives route remounts.
const tokens = new WeakMap<QueryClient, Partial<Record<Domain, string>>>();

function advance(client: QueryClient, domain: Domain) {
  const current = tokens.get(client) ?? {};
  current[domain] = crypto.randomUUID();
  tokens.set(client, current);
}

export function freshContentUrl(client: QueryClient, domain: Domain, url: string) {
  const token = tokens.get(client)?.[domain];
  return token ? `${url}${url.includes("?") ? "&" : "?"}_r=${token}` : url;
}

export async function refreshCommunityContent(
  client: QueryClient,
  username: string,
  postId?: string,
  deleted = false,
) {
  advance(client, "community");
  if (deleted && postId) client.setQueryData(["community", "post-detail", postId], null);
  await Promise.all([
    client.invalidateQueries({ queryKey: ["community", "own-posts"] }),
    client.invalidateQueries({ queryKey: ["community", "profile", username] }),
    client.invalidateQueries({ queryKey: ["community", "feed"] }),
    ...(postId
      ? [client.invalidateQueries({ queryKey: ["community", "post-detail", postId] })]
      : []),
  ]);
}

export async function refreshCosplayContent(
  client: QueryClient,
  status: "draft" | "published" = "published",
  deletedSlug?: string,
) {
  const drafts = client.invalidateQueries({ queryKey: ["cosplay", "own-drafts"] });
  if (status === "draft") {
    await drafts;
    return;
  }
  advance(client, "cosplay");
  if (deletedSlug) client.setQueryData(["cosplay", "post", deletedSlug], null);
  await Promise.all([
    drafts,
    client.invalidateQueries({ queryKey: ["cosplay", "list"] }),
    client.invalidateQueries({ queryKey: ["cosplay", "post"] }),
  ]);
}
