// Iconos propios (no son assets de Instagram): corazón y burbuja de comentario.
const ICON = {
  width: 16,
  height: 16,
  viewBox: "0 0 24 24",
  fill: "currentColor",
  "aria-hidden": true,
} as const;

export function HeartIcon() {
  return (
    <svg {...ICON}>
      <path d="M12 21s-7.5-4.6-9.6-9.2C.9 8.4 2.7 5 6.1 5c2 0 3.3 1 3.9 2.1h4C14.6 6 15.9 5 17.9 5c3.4 0 5.2 3.4 3.7 6.8C19.5 16.4 12 21 12 21z" />
    </svg>
  );
}

export function CommentIcon() {
  return (
    <svg {...ICON}>
      <path d="M4 4h16a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2h-8l-5 4v-4H4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z" />
    </svg>
  );
}
