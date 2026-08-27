import { globSync } from "node:fs";
import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
process.env.NODE_ENV = "test";

const files = [
  ...globSync("src/**/*.test.ts", { cwd: root }),
  ...globSync("src/**/*.test.tsx", { cwd: root })
].map((file) => resolve(root, file));

if (!files.length) {
  throw new Error("Не найдены тесты");
}

const child = spawn(process.execPath, ["--import", "tsx", "--test", ...files], {
  cwd: root,
  stdio: "inherit",
  env: process.env
});

child.on("exit", (code) => process.exit(code ?? 1));
