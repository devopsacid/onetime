import { isAbsolute, join, resolve } from "node:path";
import { MAX_LARGE_STORED_BYTES, MAX_STORED_BYTES, MAX_STORED_SECRETS } from "../src/shared/limits";

export interface Config {
  host: string;
  port: number;
  dbPath: string;
  distDir: string;
  migrationsDir: string;
  maxStored: number;
  /** Open sockets the server accepts at once; more are closed on arrival. */
  maxConnections: number;
  /** Bytes of all stored blobs together (the capped insert refuses beyond this). */
  maxStoredBytes: number;
  /** Large blobs (above 16,418 bytes: files) insert only while the total stays at or below this. 0 turns large blobs off. */
  maxLargeBytes: number;
  /** POST /api/secrets requests handled at once; more get 503 with Retry-After. */
  maxUploads: number;
}

export class ConfigError extends Error {
  constructor(public readonly problems: string[]) {
    super(`Invalid configuration:\n${problems.map((p) => `  ${p}`).join("\n")}`);
    this.name = "ConfigError";
  }
}

type Env = Record<string, string | undefined>;

/**
 * Reads the environment (see docs/plans/self-host.md D9). `bundleDir` is the folder of the server bundle
 * (dist-server/), `cwd` resolves relative paths. Empty values count as unset. Collects every problem before throwing.
 */
export function parseConfig(env: Env, bundleDir: string, cwd: string): Config {
  const problems: string[] = [];
  const value = (name: string): string | undefined => (env[name] === undefined || env[name] === "" ? undefined : env[name]);
  const path = (name: string, fallback: string): string => {
    const v = value(name);
    if (v === undefined) return fallback;
    if (v.includes("\0")) {
      problems.push(`${name} must not contain a NUL character`);
      return fallback;
    }
    return isAbsolute(v) ? v : resolve(cwd, v);
  };
  const integer = (name: string, fallback: number, min: number, max: number): number => {
    const v = value(name);
    if (v === undefined) return fallback;
    if (!/^\d+$/.test(v) || Number(v) < min || Number(v) > max) {
      problems.push(`${name} must be a whole number from ${min} to ${max} (got ${JSON.stringify(v.slice(0, 40))})`);
      return fallback;
    }
    return Number(v);
  };

  const maxStoredBytes = integer("ONETIME_MAX_STORED_BYTES", MAX_STORED_BYTES, 1_000_000, 1_000_000_000_000);
  // The large budget cannot exceed the total: when only the total is lowered, the default follows it.
  const largeDefault = Math.min(MAX_LARGE_STORED_BYTES, maxStoredBytes);
  const maxLargeBytes = integer("ONETIME_MAX_LARGE_BYTES", largeDefault, 0, maxStoredBytes);

  let host = "127.0.0.1";
  const hostValue = value("HOST");
  if (hostValue !== undefined) {
    if (/^[A-Za-z0-9.:_-]+$/.test(hostValue)) host = hostValue;
    else problems.push(`HOST must be an IP address or a host name (got ${JSON.stringify(hostValue.slice(0, 40))})`);
  }

  const config: Config = {
    host,
    port: integer("PORT", 8080, 0, 65535),
    dbPath: path("ONETIME_DB", resolve(cwd, "data", "onetime.db")),
    distDir: path("ONETIME_DIST", join(bundleDir, "..", "dist-selfhost")),
    migrationsDir: join(bundleDir, "..", "migrations"),
    maxStored: integer("ONETIME_MAX_STORED", MAX_STORED_SECRETS, 1, 10_000_000),
    maxConnections: integer("ONETIME_MAX_CONNECTIONS", 1000, 1, 100_000),
    maxStoredBytes,
    maxLargeBytes,
    maxUploads: integer("ONETIME_MAX_UPLOADS", 16, 1, 1000),
  };
  if (problems.length > 0) throw new ConfigError(problems);
  return config;
}
