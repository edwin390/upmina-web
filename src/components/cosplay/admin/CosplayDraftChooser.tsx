import { useEffect, useRef } from "react";
import { useQuery } from "@tanstack/react-query";
import { useLocale, useTranslations } from "use-intl";
import { useAuth } from "@/lib/auth-context";
import { listOwnCosplayDrafts } from "@/lib/cosplay-admin-client";

export default function CosplayDraftChooser({
  onResume,
  onNew,
  onClose,
}: {
  onResume: (id: string) => void;
  onNew: () => void;
  onClose: () => void;
}) {
  const t = useTranslations("cosplay.admin.drafts");
  const locale = useLocale();
  const { user } = useAuth();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const { data, isPending, isFetching, isError, refetch } = useQuery({
    queryKey: ["cosplay", "own-drafts", user?.id],
    queryFn: listOwnCosplayDrafts,
    enabled: Boolean(user),
    staleTime: 0,
  });
  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (!dialog.open) dialog.showModal();
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      dialog.close();
      document.body.style.overflow = previousOverflow;
    };
  }, []);
  useEffect(() => {
    if (!isFetching && !isError && data?.items.length === 0) onNew();
  }, [data, isFetching, isError, onNew]);
  return (
    <dialog
      ref={dialogRef}
      aria-labelledby="cosplay-drafts-title"
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      className="fixed inset-0 m-auto max-h-[90vh] w-[calc(100%_-_2rem)] max-w-lg overflow-y-auto rounded-lg border border-border-subtle bg-bg-surface p-6 text-text-primary backdrop:bg-black/80"
    >
      <h2 id="cosplay-drafts-title" className="font-display text-xl">
        {t("title")}
      </h2>
      {(isPending || isFetching) && (
        <p role="status" className="mt-4">
          {t("loading")}
        </p>
      )}
      {isError && (
        <div role="alert" className="mt-4">
          <p>{t("error")}</p>
          <button type="button" onClick={() => void refetch()}>
            {t("retry")}
          </button>
        </div>
      )}
      {!isFetching && data && (
        <ul className="mt-4 space-y-3">
          {data.items.map((draft) => (
            <li key={draft.id}>
              <button
                type="button"
                onClick={() => onResume(draft.id)}
                className="min-h-11 w-full rounded-md border border-accent-primary/50 p-3 text-left focus-visible:outline focus-visible:outline-accent-secondary"
              >
                <span className="block break-words font-semibold">{draft.title}</span>
                <span className="block text-sm text-text-secondary">
                  {Number.isFinite(Date.parse(draft.updatedAt))
                    ? new Intl.DateTimeFormat(locale, {
                        dateStyle: "medium",
                        timeStyle: "short",
                      }).format(new Date(draft.updatedAt))
                    : ""}
                </span>
                <span className="block text-accent-secondary">{t("resume")}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="mt-5 flex flex-wrap gap-3">
        {!isPending && !isFetching && !isError && (
          <button
            type="button"
            onClick={onNew}
            className="min-h-11 rounded-md border border-accent-primary px-4"
          >
            {t("createNew")}
          </button>
        )}
        <button
          type="button"
          onClick={onClose}
          className="min-h-11 rounded-md border border-border-subtle px-4"
        >
          {t("cancel")}
        </button>
      </div>
    </dialog>
  );
}
