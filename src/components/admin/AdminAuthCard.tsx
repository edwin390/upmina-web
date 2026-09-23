import type { ReactNode } from "react";

interface AdminAuthCardProps {
  title: string;
  subtitle?: string;
  children: ReactNode;
  footer?: ReactNode;
}

// Chrome visual compartido por /admin/login y /admin/signup: misma línea visual que el
// resto del sitio (font-display + barra de acento como en LegalLayout, superficie
// bg-bg-surface + borde acentuado como en CommunityCta), sin inventar un segundo design
// system para el área admin.
export default function AdminAuthCard({
  title,
  subtitle,
  children,
  footer,
}: AdminAuthCardProps) {
  return (
    <div className="mx-auto flex min-h-[70vh] max-w-md flex-col justify-center px-4 py-16">
      <div className="rounded-xl border border-accent-primary/40 bg-bg-surface p-6 sm:p-8">
        <h1 className="font-display text-3xl tracking-wide text-text-primary">{title}</h1>
        <div
          className="mt-2 h-0.5 w-12 rounded-full bg-gradient-accent"
          aria-hidden="true"
        />
        {subtitle ? <p className="mt-4 text-sm text-text-secondary">{subtitle}</p> : null}
        <div className="mt-6">{children}</div>
      </div>
      {footer ? (
        <p className="mt-6 text-center text-sm text-text-secondary">{footer}</p>
      ) : null}
    </div>
  );
}
