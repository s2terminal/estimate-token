import { defineConfig } from "vitest/config";

// GitHub Pages のサブパス(/estimate-token/)でも動くように相対パスで出力する
export default defineConfig({
  base: "./",
  build: { outDir: "dist" },
  test: { include: ["tests/**/*.test.ts"] },
});
