declare namespace Cloudflare {
  interface Env {
    DB: D1Database;
    /** Usage counters (Analytics Engine). Optional on purpose: missing locally, then nothing is counted. */
    USAGE?: AnalyticsEngineDataset;
    /** Only set by the test setup (see vitest.config.ts). */
    TEST_MIGRATIONS: import("cloudflare:test").D1Migration[];
  }
}
