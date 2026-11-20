import { normalizePassphrase, validatePassphrase, type PassphraseProblem } from "./passphrase";

/** The passphrase fields on the create form exist only for builds that write format 2. */
export function passphraseCreateEnabled(writeFormat: 1 | 2): boolean {
  return writeFormat === 2;
}

export function passphraseProblemText(problem: PassphraseProblem): string {
  if (problem === "control") return "A passphrase cannot contain control characters.";
  return "A passphrase has 8 to 256 characters.";
}

export const PASSPHRASE_DIFFER_TEXT = "The two passphrases differ.";

/** Decides what the create form passes to `encryptSecret`: a passphrase, none, or an error to show. */
export function planCreate(input: {
  enabled: boolean;
  checked: boolean;
  first: string;
  second: string;
}): { passphrase: string | undefined } | { error: string } {
  if (!input.enabled || !input.checked) return { passphrase: undefined };
  const problem = validatePassphrase(input.first);
  if (problem !== null) return { error: passphraseProblemText(problem) };
  if (normalizePassphrase(input.first) !== normalizePassphrase(input.second)) return { error: PASSPHRASE_DIFFER_TEXT };
  return { passphrase: input.first };
}
