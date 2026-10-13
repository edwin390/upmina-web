import { createClient } from "@supabase/supabase-js";
import { startRecoveryTracking } from "./password-recovery";

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL as string;
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string;

export const isSupabaseConfigured = Boolean(supabaseUrl && supabaseAnonKey);

export const supabase = isSupabaseConfigured
  ? createClient(supabaseUrl, supabaseAnonKey)
  : null;

// La marca de recuperación de contraseña nace del evento real PASSWORD_RECOVERY: se suscribe aquí, justo al crear el
// cliente y antes de que supabase-js lo emita al consumir el enlace (ver password-recovery.ts).
if (supabase) startRecoveryTracking(supabase.auth);
