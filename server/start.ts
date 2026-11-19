import type { AddressInfo } from "node:net";
import type { Config } from "./config";
import { closeGracefully, createApp } from "./http";
import { readMigrations } from "./migrate";
import { loadSite } from "./static";
import { openSqliteStore } from "./store-sqlite";

export interface Running {
  host: string;
  port: number;
  /** Stops accepting, waits for requests in flight (up to graceMs), waits for background work, closes the database. */
  shutdown(graceMs?: number): Promise<void>;
}

/** Opens everything, then listens. Throws SiteError, StoreLockedError or a listen error before anything is served. */
export async function startServer(config: Config): Promise<Running> {
  const site = loadSite(config.distDir);
  const store = openSqliteStore(config.dbPath, readMigrations(config.migrationsDir));
  const app = createApp({ store, site, maxStored: config.maxStored });
  try {
    await new Promise<void>((resolve, reject) => {
      app.server.once("error", reject);
      app.server.listen(config.port, config.host, () => {
        app.server.off("error", reject);
        resolve();
      });
    });
  } catch (error) {
    await store.close();
    throw error;
  }
  const { port } = app.server.address() as AddressInfo;
  let stopping: Promise<void> | undefined;
  return {
    host: config.host,
    port,
    shutdown(graceMs = 8000) {
      stopping ??= (async () => {
        await closeGracefully(app.server, graceMs);
        await app.drain();
        await store.close();
      })();
      return stopping;
    },
  };
}
