import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    include: ["tests/mermaid.browser.test.js"],
    testTimeout: 60000,
    hookTimeout: 60000,
    fileParallelism: false,
  },
})
