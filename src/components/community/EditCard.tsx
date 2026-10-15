import type { Edit } from "@/types";
import { formatRelativeDate } from "@/lib/format";

interface EditCardProps {
  edit: Edit;
  onVote: (editId: string, value: 1 | -1) => void;
}

export default function EditCard({ edit, onVote }: EditCardProps) {
  return (
    <div className="overflow-hidden rounded-lg border border-border-subtle bg-bg-surface">
      <div className="aspect-video bg-black">
        <video
          src={edit.videoPath}
          poster={edit.thumbnailPath}
          controls
          className="h-full w-full"
        />
      </div>
      <div className="p-3">
        <p className="font-medium text-text-primary">{edit.title}</p>
        {edit.description && (
          <p className="mt-1 line-clamp-2 text-sm text-text-secondary">
            {edit.description}
          </p>
        )}
        <div className="mt-3 flex items-center justify-between">
          <p className="text-xs text-text-muted">{formatRelativeDate(edit.createdAt)}</p>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => onVote(edit.id, 1)}
              className="rounded px-2 py-1 text-sm text-text-secondary hover:text-accent-success"
              aria-label="Votar positivo"
            >
              ▲
            </button>
            <span className="text-sm font-semibold text-text-primary">
              {edit.voteScore ?? 0}
            </span>
            <button
              type="button"
              onClick={() => onVote(edit.id, -1)}
              className="rounded px-2 py-1 text-sm text-text-secondary hover:text-accent-live"
              aria-label="Votar negativo"
            >
              ▼
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
