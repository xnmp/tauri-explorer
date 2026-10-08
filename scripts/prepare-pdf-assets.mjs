import { cp, mkdir, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const destination = resolve(root, "static/generated/pdfjs");
await rm(destination, { recursive: true, force: true });
await mkdir(destination, { recursive: true });
for (const folder of ["cmaps", "standard_fonts", "wasm", "iccs"]) {
  await cp(
    resolve(root, "node_modules/pdfjs-dist", folder),
    resolve(destination, folder),
    { recursive: true },
  );
}
await cp(
  resolve(root, "node_modules/pdfjs-dist/LICENSE"),
  resolve(destination, "LICENSE"),
);
