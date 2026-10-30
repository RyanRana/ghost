import { defineConfig } from "vitest/config"

// The MySQL and MariaDB suites talk to real servers.
export default defineConfig({ test: { testTimeout: 30_000 } })
