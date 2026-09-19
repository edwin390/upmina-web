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

const command = process.platform === "win32" ? "npx.cmd" : "npx";
const children = [
  spawn(command, ["vercel", "dev", "--listen", "3001"], {
    env: process.env,
    stdio: "inherit",
    shell: process.platform === "win32",
  }),
  spawn(command, ["vite", "--port", "3000"], {
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