import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    include: ["*.test.js", "tests/**/*.test.js"],
    exclude: ["tests/mermaid.browser.test.js"],
    testTimeout: 20000,
  },
})
