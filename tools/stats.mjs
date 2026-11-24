#!/usr/bin/env node
// Daily usage totals from Workers Analytics Engine (docs/plans/usage-counters.md). Private, run by the owner.
//
//   ONETIME_STATS_ACCOUNT_ID=... ONETIME_STATS_TOKEN=... node tools/stats.mjs [--days N] [--format table|tsv]
//
// The token (a read-only "Account Analytics: Read" token) is taken from the environment only; a token-like argument is
// refused. One request per run. Not shipped in any dist.
import { fetchStats, format, parseArgs, StatsError } from "./stats-core.mjs";

try {
  const { days, format: how } = parseArgs(process.argv.slice(2));
  const rows = await fetchStats({ env: process.env, days });
  console.log(format(rows, how));
} catch (error) {
  if (error instanceof StatsError) {
    console.error(`stats: ${error.message}`);
    process.exit(error.code);
  }
  console.error("stats: unexpected error");
  process.exit(1);
}
