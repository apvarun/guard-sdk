import { defineConfig } from "vite-plus";

export default defineConfig({
  staged: {
    "*": "vp check --fix",
  },
  fmt: {
    ignorePatterns: ["packages/*/src/**/*.d.ts"],
  },
  lint: {
    ignorePatterns: ["packages/*/src/**/*.d.ts"],
    options: { typeAware: true, typeCheck: true },
  },
  run: {
    cache: true,
  },
});
