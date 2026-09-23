import type { InputHTMLAttributes } from "react";

interface AdminAuthFieldProps extends InputHTMLAttributes<HTMLInputElement> {
  label: string;
  id: string;
  errorId?: string;
}

// Input etiquetado compartido por login/signup: mismo tratamiento visual que el input
// existente de UploadEditForm (borde sutil, superficie bg-bg-base, foco en
// accent-secondary), con un anillo de foco visible adicional para consistencia con el
// resto de controles interactivos del sitio (enlaces/botones ya usan
// focus-visible:ring-accent-secondary).
export default function AdminAuthField({
  label,
  id,
  errorId,
  className,
  ...inputProps
}: AdminAuthFieldProps) {
  return (
    <div>
      <label htmlFor={id} className="mb-1 block text-sm text-text-secondary">
        {label}
      </label>
      <input
        id={id}
        aria-describedby={errorId}
        className={
          className ??
          "w-full rounded-md border border-border-subtle bg-bg-base px-3 py-2 text-text-primary outline-none focus:border-accent-secondary focus-visible:ring-2 focus-visible:ring-accent-secondary"
        }
        {...inputProps}
      />
    </div>
  );
}
