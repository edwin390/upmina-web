import { Link } from "react-router-dom";
import { useTranslations } from "use-intl";
import UpminaLocaleProvider from "@/i18n/LocaleProvider";

// Piezas de /login para «Olvidé mi contraseña», traducidas con el sistema existente (namespace `auth`).

function LinkContent() {
  const t = useTranslations("auth.forgotPassword");
  return (
    <Link
      to="/forgot-password"
      className="text-sm font-medium text-accent-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-secondary"
    >
      {t("link")}
    </Link>
  );
}

export function ForgotPasswordLink() {
  return (
    <UpminaLocaleProvider>
      <LinkContent />
    </UpminaLocaleProvider>
  );
}

function NoticeContent() {
  const t = useTranslations("auth.forgotPassword");
  return (
    <p
      role="status"
      className="rounded-lg border border-accent-success/40 bg-accent-success/5 p-4 text-sm text-text-secondary"
    >
      {t("passwordUpdated")}
    </p>
  );
}

/** Aviso tras restablecer la contraseña (la sesión de recuperación ya se cerró). */
export function PasswordUpdatedNotice() {
  return (
    <UpminaLocaleProvider>
      <NoticeContent />
    </UpminaLocaleProvider>
  );
}
