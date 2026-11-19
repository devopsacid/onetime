import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { ConfigError, parseConfig } from "./config";
import { permissionWarning } from "./permissions";
import { SiteError } from "./static";
import { startServer } from "./start";
import { StoreLockedError } from "./store-sqlite";

declare const __VERSION__: string | undefined;
const version = typeof __VERSION__ === "string" ? __VERSION__ : "dev";

/** Exit codes: 2 = bad configuration or site folder, 3 = database locked by another process, 1 = anything else. */
async function main(): Promise<void> {
  const [major = 0, minor = 0] = process.versions.node.split(".").map(Number);
  if (major < 22 || (major === 22 && minor < 13)) {
    process.stderr.write(`onetime: Node 22.13 or newer is required (this is ${process.versions.node})\n`);
    process.exit(2);
  }
  // Everything the server creates (database, WAL, directory) is private to its user.
  process.umask(0o077);

  let running: Awaited<ReturnType<typeof startServer>>;
  let dbPath = "";
  let maxStored = 0;
  try {
    const config = parseConfig(process.env, dirname(fileURLToPath(import.meta.url)), process.cwd());
    dbPath = config.dbPath;
    maxStored = config.maxStored;
    running = await startServer(config);
  } catch (error) {
    if (error instanceof ConfigError || error instanceof SiteError) {
      process.stderr.write(`onetime: ${error.message}\n`);
      process.exit(2);
    }
    if (error instanceof StoreLockedError) {
      process.stderr.write(`onetime: ${error.message}\n`);
      process.exit(3);
    }
    process.stderr.write(`onetime: could not start (${(error as { code?: string }).code ?? (error as Error).name})\n`);
    process.exit(1);
  }

  const warning = permissionWarning(dbPath);
  if (warning !== null) process.stderr.write(`${warning}\n`);
  process.stdout.write(`onetime ${version} listening on ${running.host}:${running.port}, db ${dbPath}, max ${maxStored} secrets\n`);

  let stopping = false;
  const stop = (): void => {
    // A second signal ends the process at once.
    if (stopping) process.exit(1);
    stopping = true;
    running.shutdown().then(
      () => process.exit(0),
      () => process.exit(1),
    );
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
}

void main();
