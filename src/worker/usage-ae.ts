import { noUsage, type Usage } from "./usage";

/**
 * Usage counters in Workers Analytics Engine (docs/plans/usage-counters.md). Cloudflare-specific, so it lives next to
 * store-d1.ts and not in the runtime-neutral router. Each count is one data point holding only the event and the label
 * (blobs) and the event (index): no id, key, blob, size, address, header or URL. Count with SUM(_sample_interval).
 * Without a binding (local dev, a misconfigured deploy) it counts nothing.
 */
export function analyticsEngineUsage(dataset: AnalyticsEngineDataset | undefined): Usage {
  if (dataset === undefined) return noUsage;
  return {
    count(event, label) {
      try {
        // Not awaited and no waitUntil: the runtime writes in the background.
        dataset.writeDataPoint({ blobs: [event, label], indexes: [event] });
      } catch {
        // A counter never fails a request.
      }
    },
  };
}
