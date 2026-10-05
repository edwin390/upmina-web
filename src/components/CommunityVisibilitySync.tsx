import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { listenCommunityVisibility } from "@/lib/community-visibility-sync";

export default function CommunityVisibilitySync() {
  const client = useQueryClient();
  useEffect(() => listenCommunityVisibility(client), [client]);
  return null;
}
