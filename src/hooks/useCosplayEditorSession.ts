import { useCallback, useEffect, useRef, useState } from "react";
import { useAuth } from "@/lib/auth-context";
import { supabase } from "@/lib/supabase";

/** A live editor belongs to one identity and one uninterrupted auth lifecycle. */
export function useCosplayEditorSession() {
  const auth = useAuth();
  const identity = auth.session && !auth.loading ? (auth.user?.id ?? null) : null;
  const generation = auth.identityGeneration ?? 0;
  const owner = useRef({ identity, generation });
  const current = useRef({ identity, generation });
  current.current = { identity, generation };
  const mounted = useRef(true);
  const invalid = useRef(false);
  const [invalidSession, setInvalidSession] = useState(false);
  if (
    !identity ||
    identity !== owner.current.identity ||
    generation !== owner.current.generation
  ) {
    invalid.current = true;
  }
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const isActive = useCallback(
    () =>
      mounted.current &&
      !invalid.current &&
      current.current.identity === owner.current.identity &&
      current.current.generation === owner.current.generation,
    [],
  );
  const invalidate = useCallback(() => {
    invalid.current = true;
    if (mounted.current) setInvalidSession(true);
  }, []);
  const isCurrent = useCallback(async () => {
    if (!isActive() || !supabase) return false;
    try {
      const { data, error } = await supabase.auth.getSession();
      if (!error && data.session?.user.id === owner.current.identity && isActive())
        return true;
    } catch {
      /* Fail closed, never transfer an old editor to another identity. */
    }
    invalid.current = true;
    if (mounted.current) setInvalidSession(true);
    return false;
  }, [isActive]);
  return {
    userId: owner.current.identity,
    isActive,
    isCurrent,
    invalidate,
    invalidSession: invalidSession || invalid.current,
  };
}
