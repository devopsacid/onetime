export const INFO_PROJECT: string;
export function assertInfoDist(dir: string): void;
export function deployPlan(opts: { repo: string; sha: string; tmpBase: string }): { command: string; args: string[]; cwdParent: string };
export function preflight(
  repo: string,
  run?: (command: string, args: string[]) => { status: number | null; stdout?: string | null; stderr?: string | null },
): void;
