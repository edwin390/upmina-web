import { useEffect } from "react";
import { createPortal } from "react-dom";
import { Link } from "react-router-dom";
import { useTranslations } from "use-intl";
import type { AccountIncompleteReason } from "@/lib/account-incomplete";
import UpminaLocaleProvider from "@/i18n/LocaleProvider";

// AUTH-2: aviso de CUENTA INCOMPLETA (email sin verificar / username pendiente). No es una
// sanción: no usa CommunityRestrictionNotice ni nada de strikes. Textos del namespace `auth`
// (ES/EN/DE) con el proveedor de idioma existente, montado aquí hasta que I18N-1 lo suba a la app.

const ACCOUNT_PATH = "/account";
const LINK_CLASS =
  "inline-flex min-h-11 items-center font-semibold text-accent-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-secondary";

interface NoticeProps {
  reason: AccountIncompleteReason;
  /** true = el usuario tiene un borrador en pantalla (editor): se aclara que no se pierde. */
  keepsDraft?: boolean;
}

function NoticeContent({ reason, keepsDraft = false }: NoticeProps) {
  const t = useTranslations("auth.accountIncomplete");
  const username = reason === "username_missing";
  const body = username
    ? keepsDraft
      ? t("usernameBodyDraft")
      : t("usernameBody")
    : keepsDraft
      ? t("emailBodyDraft")
      : t("emailBody");
  return (
    <>
      <strong className="block text-text-primary">
        {username ? t("usernameTitle") : t("emailTitle")}
      </strong>
      <span className="mt-1 block">{body}</span>
      {username ? (
        <Link to={ACCOUNT_PATH} className={LINK_CLASS}>
          {t("usernameAction")}
        </Link>
      ) : null}
    </>
  );
}

/** Aviso en línea (editor): no borra el borrador ni reintenta nada. */
export default function AccountIncompleteNotice(props: NoticeProps) {
  return (
    <UpminaLocaleProvider>
      <div
        role="alert"
        className="mt-3 rounded-lg border border-accent-warning/40 bg-accent-warning/5 p-4 text-sm leading-relaxed text-text-secondary"
      >
        <NoticeContent {...props} />
      </div>
    </UpminaLocaleProvider>
  );
}

const TOAST_MS = 9000;

/** Aviso flotante (acciones sin formulario, p. ej. Like). Se cierra solo; temporizador limpiado. */
export function AccountIncompleteToast({
  reason,
  onDismiss,
}: {
  reason: AccountIncompleteReason;
  onDismiss: () => void;
}) {
  useEffect(() => {
    const timer = window.setTimeout(onDismiss, TOAST_MS);
    return () => window.clearTimeout(timer);
  }, [reason, onDismiss]);
  return createPortal(
    <UpminaLocaleProvider>
      <div className="pointer-events-none fixed inset-x-0 bottom-6 z-[60] flex justify-center px-4">
        <div
          role="alert"
          className="pointer-events-auto max-w-lg rounded-md border border-accent-warning/60 bg-bg-surface px-4 py-3 text-sm text-text-secondary shadow-lg"
        >
          <NoticeContent reason={reason} />
        </div>
      </div>
    </UpminaLocaleProvider>,
    document.body,
  );
}
