import { useEffect, useState } from "react";
import { supabase } from "@/lib/supabase";
import EditsFeed from "./EditsFeed";
import UploadEditForm from "./UploadEditForm";

export default function CommunitySection() {
  const [userId, setUserId] = useState<string | null>(null);

  useEffect(() => {
    if (!supabase) return;

    supabase.auth.getUser().then(({ data }) => {
      setUserId(data.user?.id ?? null);
    });
    const { data: sub } = supabase.auth.onAuthStateChange((_event, session) => {
      setUserId(session?.user?.id ?? null);
    });
    return () => sub.subscription.unsubscribe();
  }, []);

  return (
    <section className="mx-auto max-w-6xl px-4 py-16">
      <h2 className="mb-6 font-display text-3xl tracking-wide">COMUNIDAD</h2>

      {userId ? (
        <div className="mb-10 max-w-xl">
          <h3 className="mb-3 text-lg font-semibold text-text-primary">Sube tu edit</h3>
          <UploadEditForm authorId={userId} />
        </div>
      ) : (
        <p className="mb-10 text-text-muted">
          Inicia sesión para subir tus propios edits y votar los de la comunidad.
        </p>
      )}

      <EditsFeed />
    </section>
  );
}
