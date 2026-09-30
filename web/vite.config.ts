import { defineConfig } from "vite";
import preact from "@preact/preset-vite";
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const pkg = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8")) as { version: string };

// Cloudflare Pages provides the commit; locally ask git.
function commit(): string {
  if (process.env.CF_PAGES_COMMIT_SHA) return process.env.CF_PAGES_COMMIT_SHA.slice(0, 7);
  try {
    return execSync("git rev-parse --short=7 HEAD", { stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
  } catch {
    return "dev";
  }
}

const build = { version: pkg.version, commit: commit(), builtAt: new Date().toISOString() };

export default defineConfig({
  plugins: [
    preact(),
    // /version.json lets a running (older) app notice that a newer deploy exists.
    {
      name: "version-json",
      generateBundle() {
        this.emitFile({ type: "asset", fileName: "version.json", source: JSON.stringify(build) });
      },
    },
  ],
  define: {
    __APP_VERSION__: JSON.stringify(build.version),
    __APP_COMMIT__: JSON.stringify(build.commit),
    __APP_BUILD_TIME__: JSON.stringify(build.builtAt),
  },
  resolve: {
    alias: { "@shared": fileURLToPath(new URL("../supabase/functions/_shared", import.meta.url)) },
  },
  server: { fs: { allow: [".."] } },
  build: { target: "es2022" },
});
