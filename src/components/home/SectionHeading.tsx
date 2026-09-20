interface SectionHeadingProps {
  id: string;
  title: string;
  subtitle?: string;
}

export default function SectionHeading({ id, title, subtitle }: SectionHeadingProps) {
  return (
    <div className="mb-6">
      <h2 id={id} className="font-display text-3xl tracking-wide text-text-primary">
        {title}
      </h2>
      <div
        className="mt-2 h-0.5 w-12 rounded-full bg-gradient-accent"
        aria-hidden="true"
      />
      {subtitle && <p className="mt-3 text-sm text-text-secondary">{subtitle}</p>}
    </div>
  );
}
