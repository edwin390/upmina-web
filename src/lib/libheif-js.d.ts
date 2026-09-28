// libheif-js no publica tipos (ni @types/libheif-js ni un campo "types" en su package.json): esta
// declaración ambiental mínima solo evita el error de "módulo sin tipos" al importarlo. La forma
// real que se usa se tipa aparte, en el sitio de uso (ver LibheifModule en media-processing.ts).
declare module "libheif-js";
