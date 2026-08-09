import { cp, mkdir, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const source = resolve(root, "client");
const destination = resolve(root, "public", "client");

if (!destination.startsWith(resolve(root, "public"))) {
  throw new Error("Refusing to sync outside the public directory.");
}

await rm(destination, { recursive: true, force: true });
await mkdir(destination, { recursive: true });
await cp(source, destination, { recursive: true });

console.log("Portable client synchronized for preview.");
