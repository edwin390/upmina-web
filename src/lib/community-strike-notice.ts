import type { SupabaseClient } from "@supabase/supabase-js";
import type { CopyrightNoticeErrorClass } from "./copyright-contract.js";
import { sendCopyrightNotice } from "./copyright-mail.js";
import type { MailConfig } from "./mfa-recovery-mail.js";

// Aviso por correo (en inglés) de un strike de Community CONFIRMADO. Reutiliza el generador y el proveedor del aviso de strikes de
// Copyright (sendCopyrightNotice) y su registro (copyright_strike_notices, ahora por strike). Nunca lanza y nunca altera la respuesta de
// la aplicación del strike: un fallo del correo queda registrado como error reintentable y NO repite la sanción. El aviso solo existe
// para un strike real y no revocado, y un aviso ya enviado no se repite (la RPC lo deniega y la clave de idempotencia es estable).

export type CommunityStrikeNoticeOutcome =
  | { notice: "sent" }
  | { notice: "skipped" }
  | { notice: "failed"; noticeError: CopyrightNoticeErrorClass };

interface NoticeContext {
  strikeId: string;
  strike: {
    authorEmail: string | null;
    level: 1 | 2 | 3;
    permanent: boolean;
    endsAt: string | null;
    reason: string;
  };
}

function readContext(value: unknown): NoticeContext | null {
  const root = value as Record<string, unknown> | null;
  const strike = root?.strike as Record<string, unknown> | null | undefined;
  if (!root || typeof root.strikeId !== "string" || !strike || typeof strike !== "object")
    return null;
  const level = strike.level;
  if (level !== 1 && level !== 2 && level !== 3) return null;
  if (typeof strike.reason !== "string" || strike.reason.length === 0) return null;
  return {
    strikeId: root.strikeId,
    strike: {
      authorEmail: typeof strike.authorEmail === "string" ? strike.authorEmail : null,
      level,
      permanent: strike.permanent === true,
      endsAt: typeof strike.endsAt === "string" ? strike.endsAt : null,
      reason: strike.reason,
    },
  };
}

function businessCode(error: unknown): string | null {
  const { code, message } = (error ?? {}) as { code?: unknown; message?: unknown };
  return code === "P0001" && typeof message === "string" ? message : null;
}

export async function notifyCommunityStrike(
  client: SupabaseClient,
  mail: () => MailConfig | null,
  actor: string,
  strikeId: string,
): Promise<CommunityStrikeNoticeOutcome> {
  try {
    const ctx = await client.rpc("community_strike_notice_context", {
      p_actor_user_id: actor,
      p_strike_id: strikeId,
    });
    if (ctx.error) {
      // «invalid_transition»: ya notificado o revocado → no se envía nada.
      if (businessCode(ctx.error) === "invalid_transition") return { notice: "skipped" };
      return { notice: "failed", noticeError: "provider_unavailable" };
    }
    const context = readContext(ctx.data);
    if (!context) return { notice: "failed", noticeError: "invalid_response" };
    const outcome = await sendCopyrightNotice(mail(), {
      to: context.strike.authorEmail,
      idempotencyKey: `community-strike:${strikeId}`,
      input: {
        kind: "community_strike",
        reference: "",
        reason: context.strike.reason,
        windowMinutes: 0,
        strike: {
          level: context.strike.level,
          permanent: context.strike.permanent,
          endsAt: context.strike.endsAt,
        },
      },
    });
    const errorClass: CopyrightNoticeErrorClass | null =
      outcome.ok === false ? outcome.errorClass : null;
    const rec = await client.rpc("community_strike_notice_record", {
      p_actor_user_id: actor,
      p_strike_id: strikeId,
      p_ok: outcome.ok,
      p_error_class: errorClass,
    });
    if (rec.error)
      return { notice: "failed", noticeError: errorClass ?? "provider_unavailable" };
    return outcome.ok
      ? { notice: "sent" }
      : { notice: "failed", noticeError: errorClass! };
  } catch {
    return { notice: "failed", noticeError: "provider_unavailable" };
  }
}
