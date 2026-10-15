import { Fragment, useEffect, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { resolveInitialLocale } from "@/i18n/locale";
import type { Locale } from "@/i18n/locale-core";

// Documentos legales (Términos, Privacidad, Aviso legal, Normas de comunidad) en ES/EN/DE. El texto vive en
// src/content/legal/<idioma>/<documento>.md y se carga de forma perezosa SOLO para el idioma resuelto por el
// mecanismo existente (resolveInitialLocale: preferencia guardada o idioma del navegador; ES por defecto). El
// renderizador es mínimo y construye elementos de React (nunca HTML en crudo) para el subconjunto de Markdown usado.
export type LegalDocId = "terms" | "privacy" | "legal" | "rules";

const FILES = import.meta.glob<string>("/src/content/legal/*/*.md", {
  query: "?raw",
  import: "default",
});

async function loadDocument(locale: Locale, doc: LegalDocId): Promise<string> {
  const load =
    FILES[`/src/content/legal/${locale}/${doc}.md`] ??
    FILES[`/src/content/legal/es/${doc}.md`];
  return load ? load() : "";
}

const INLINE = /(\*\*[^*]+\*\*|\[[^\]]+\]\([^)]+\)|`[^`]+`)/g;

function inline(text: string): ReactNode[] {
  return text.split(INLINE).map((part, i) => {
    if (part.startsWith("**") && part.endsWith("**")) {
      const inner = part.slice(2, -2);
      if (/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(inner)) {
        return (
          <a
            key={i}
            href={`mailto:${inner}`}
            className="font-medium text-accent-primary hover:underline"
          >
            {inner}
          </a>
        );
      }
      return (
        <strong key={i} className="text-text-primary">
          {part.slice(2, -2)}
        </strong>
      );
    }
    if (part.startsWith("`") && part.endsWith("`"))
      return <code key={i}>{part.slice(1, -1)}</code>;
    const link = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(part);
    if (link) {
      const [, label, href] = link;
      const cls = "font-medium text-accent-primary hover:underline";
      if (href.startsWith("/")) {
        return (
          <Link key={i} to={href} className={cls}>
            {label}
          </Link>
        );
      }
      if (/^https?:\/\//.test(href)) {
        return (
          <a
            key={i}
            href={href}
            target="_blank"
            rel="noopener noreferrer"
            className={cls}
          >
            {label}
          </a>
        );
      }
    }
    return <Fragment key={i}>{part}</Fragment>;
  });
}

const cells = (line: string) =>
  line
    .trim()
    .replace(/^\||\|$/g, "")
    .split("|")
    .map((c) => c.trim());

function parseLegalMarkdown(md: string): { title: string; blocks: ReactNode[] } {
  const lines = md.replace(/\r\n/g, "\n").split("\n");
  const blocks: ReactNode[] = [];
  let title = "";
  let i = 0;
  let key = 0;
  let firstParagraph = true;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) {
      i++;
      continue;
    }
    if (line.startsWith("# ")) {
      title = line.slice(2).trim();
      i++;
    } else if (line.startsWith("### ")) {
      blocks.push(
        <h3 key={key++} className="pt-2 text-base font-semibold text-text-primary">
          {inline(line.slice(4))}
        </h3>,
      );
      i++;
    } else if (line.startsWith("## ")) {
      blocks.push(
        <h2 key={key++} className="pt-4 text-xl font-semibold text-text-primary">
          {inline(line.slice(3))}
        </h2>,
      );
      i++;
    } else if (line.startsWith("|")) {
      const rows: string[][] = [];
      while (i < lines.length && lines[i].startsWith("|")) {
        if (!/^\|\s*-/.test(lines[i])) rows.push(cells(lines[i]));
        i++;
      }
      const [head, ...body] = rows;
      blocks.push(
        <div key={key++} className="overflow-x-auto">
          <table className="w-full border-collapse text-left text-sm">
            <thead>
              <tr>
                {head.map((c, j) => (
                  <th
                    key={j}
                    className="border-b border-border-subtle px-3 py-2 font-semibold text-text-primary"
                  >
                    {inline(c)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {body.map((r, j) => (
                <tr key={j}>
                  {r.map((c, k) => (
                    <td
                      key={k}
                      className="border-b border-border-subtle/60 px-3 py-2 align-top"
                    >
                      {inline(c)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>,
      );
    } else if (/^- /.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^- /.test(lines[i])) items.push(lines[i++].slice(2));
      blocks.push(
        <ul key={key++} className="list-disc space-y-1.5 pl-5">
          {items.map((t, j) => (
            <li key={j}>{inline(t)}</li>
          ))}
        </ul>,
      );
    } else if (/^\d+\. /.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\d+\. /.test(lines[i]))
        items.push(lines[i++].replace(/^\d+\.\s+/, ""));
      blocks.push(
        <ol key={key++} className="list-decimal space-y-1.5 pl-5">
          {items.map((t, j) => (
            <li key={j}>{inline(t)}</li>
          ))}
        </ol>,
      );
    } else {
      const parts: string[] = [];
      while (i < lines.length && lines[i].trim() && !/^(#|\||- |\d+\. )/.test(lines[i])) {
        parts.push(lines[i++].trim());
      }
      blocks.push(
        <p key={key++} className={firstParagraph ? "text-sm text-text-muted" : undefined}>
          {inline(parts.join(" "))}
        </p>,
      );
      firstParagraph = false;
    }
  }
  return { title, blocks };
}

export default function LegalDocument({ doc }: { doc: LegalDocId }) {
  const [locale] = useState<Locale>(resolveInitialLocale);
  const [md, setMd] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    loadDocument(locale, doc).then((text) => {
      if (!cancelled) setMd(text);
    });
    return () => {
      cancelled = true;
    };
  }, [locale, doc]);

  const parsed = md ? parseLegalMarkdown(md) : null;

  useEffect(() => {
    if (!parsed?.title) return;
    const previous = document.title;
    document.title = `${parsed.title} — UPMINAA Fan Site`;
    return () => {
      document.title = previous;
    };
  }, [parsed?.title]);

  if (!parsed) {
    return (
      <p
        className="mx-auto max-w-3xl px-4 py-16 text-sm text-text-secondary"
        role="status"
      >
        …
      </p>
    );
  }

  return (
    <article lang={locale} className="mx-auto max-w-3xl px-4 py-16">
      <h1 className="font-display text-4xl tracking-wide text-text-primary md:text-5xl">
        {parsed.title}
      </h1>
      <div
        className="mt-2 h-0.5 w-12 rounded-full bg-gradient-accent"
        aria-hidden="true"
      />
      <div className="mt-8 space-y-4 leading-relaxed text-text-secondary">
        {parsed.blocks}
      </div>
    </article>
  );
}
