import { readFileSync } from "node:fs";
import { spawn } from "node:child_process";

function loadEnvFile(path) {
  try {
    const lines = readFileSync(path, "utf8").split(/\r?\n/);
    for (const line of lines) {
      const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
      if (!match || match[1] in process.env) continue;

      const value = match[2].replace(/^("|')(.*)\1$/, "$2");
      process.env[match[1]] = value;
    }
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}

loadEnvFile(".env.local");
loadEnvFile(".env");

// "vercel" resuelve al paquete fijado en package.json (devDependency), no a la última versión de
// npm: vercel@60.0.0+ crashea de forma reproducible en este entorno (Node 24.x + Windows) con
// "Assertion failed: !(handle->flags & UV_HANDLE_CLOSING), file src\win\async.c, line 94" al
// primer request real a cualquier función — no es un problema de ninguna función concreta del
// proyecto (se reprodujo incluso sin api/media/). vercel@59.19.1 no lo reproduce, verificado con
// requests reales contra varias funciones. Antes de subir la versión fijada, repetir esa prueba.
const command = process.platform === "win32" ? "npx.cmd" : "npx";
const children = [
  spawn(command, ["vercel", "dev", "--listen", "3001"], {
    env: process.env,
    stdio: "inherit",
    shell: process.platform === "win32",
  }),
  // --host 0.0.0.0 (Fase 9I-2C, prueba real desde el móvil por LAN): SOLO el frontend de Vite
  // necesita ser alcanzable desde otro dispositivo — el proxy de /api (vite.config.ts) sigue
  // hablando con Vercel dev en 127.0.0.1:3001 desde el propio proceso de Vite (loopback de esta
  // misma máquina, nunca expuesto directamente a la LAN). Nunca se exponen credenciales
  // server-side: el navegador del móvil solo recibe lo mismo que ya recibiría en localhost.
  spawn(command, ["vite", "--port", "3000", "--host", "0.0.0.0"], {
    env: process.env,
    stdio: "inherit",
    shell: process.platform === "win32",
  }),
];

function stopChildren() {
  for (const child of children) {
    if (!child.killed) child.kill();
  }
}

process.on("SIGINT", () => {
  stopChildren();
  process.exit(0);
});
process.on("SIGTERM", () => {
  stopChildren();
  process.exit(0);
});

for (const child of children) {
  child.on("exit", (code) => {
    if (code && code !== 0) {
      stopChildren();
      process.exit(code);
    }
  });
}
