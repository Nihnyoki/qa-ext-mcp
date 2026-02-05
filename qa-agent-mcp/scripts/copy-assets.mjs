import fs from "node:fs";
import path from "node:path";

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function copyFile(src, dest) {
  ensureDir(path.dirname(dest));
  fs.copyFileSync(src, dest);
}

const projectRoot = path.resolve(new URL("..", import.meta.url).pathname);

// Copy tool description JSONs into dist so runtime lookups are stable
const srcDir = path.join(projectRoot, "src", "tools", "description");
const distDir = path.join(projectRoot, "dist", "tools", "description");

if (!fs.existsSync(srcDir)) {
  console.warn(`[copy-assets] Source dir missing: ${srcDir}`);
  process.exit(0);
}

ensureDir(distDir);

const files = fs.readdirSync(srcDir).filter(f => f.endsWith(".json"));
for (const file of files) {
  copyFile(path.join(srcDir, file), path.join(distDir, file));
}

console.log(`[copy-assets] Copied ${files.length} JSON file(s) to dist.`);
