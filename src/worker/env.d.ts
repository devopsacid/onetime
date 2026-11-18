declare namespace Cloudflare {
  interface Env {
    DB: D1Database;
    /** Only set by the test setup (see vitest.config.ts). */
    TEST_MIGRATIONS: import("cloudflare:test").D1Migration[];
  }
}
