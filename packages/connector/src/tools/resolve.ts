/**
 * Speech does not produce identifiers. A voice turn says "the mac mini" or "the auth refactor",
 * never `ws_01J...`, so every reference in this connector is matched against the things that
 * actually exist and either resolves to exactly one or reports the candidates back. Guessing
 * between two plausible matches is worse than asking: the tools here start agents.
 */

export interface Candidate {
  id: string;
  /** Every string a person might say to mean this thing. */
  aliases: Array<string | null | undefined>;
}

export type ResolveResult<T> =
  | { kind: "match"; value: T }
  | { kind: "none"; query: string }
  | { kind: "ambiguous"; query: string; matches: T[] };

function normalize(value: string): string {
  return value
    .toLowerCase()
    .replace(/[_\-/\\.]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function aliasesOf(candidate: Candidate): string[] {
  return candidate.aliases
    .filter((alias): alias is string => typeof alias === "string" && alias.trim().length > 0)
    .map(normalize);
}

/**
 * Tiers are tried in order and the first tier with any hit wins, so a exact name never loses to
 * some other item that happens to contain the same word.
 */
export function resolveCandidate<T extends Candidate>(
  query: string,
  candidates: T[],
): ResolveResult<T> {
  const needle = normalize(query);
  if (!needle) {
    return { kind: "none", query };
  }

  const tiers: Array<(candidate: T) => boolean> = [
    (candidate) => candidate.id === query.trim(),
    (candidate) => aliasesOf(candidate).includes(needle),
    (candidate) => candidate.id.toLowerCase().startsWith(needle.replace(/\s+/g, "")),
    (candidate) => aliasesOf(candidate).some((alias) => alias.startsWith(needle)),
    (candidate) => aliasesOf(candidate).some((alias) => alias.includes(needle)),
    (candidate) => {
      const words = needle.split(" ").filter(Boolean);
      return (
        words.length > 1 &&
        aliasesOf(candidate).some((alias) => words.every((word) => alias.includes(word)))
      );
    },
  ];

  for (const tier of tiers) {
    const matches = candidates.filter(tier);
    if (matches.length === 1) {
      return { kind: "match", value: matches[0] as T };
    }
    if (matches.length > 1) {
      return { kind: "ambiguous", query, matches };
    }
  }

  return { kind: "none", query };
}

export class ResolutionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ResolutionError";
  }
}

/** Turns a failed resolution into a sentence Claude can read out and act on. */
export function requireCandidate<T extends Candidate>(
  query: string,
  candidates: T[],
  options: { noun: string; describe: (value: T) => string },
): T {
  const result = resolveCandidate(query, candidates);
  if (result.kind === "match") {
    return result.value;
  }
  if (result.kind === "ambiguous") {
    const names = result.matches.map((match) => options.describe(match)).join(", ");
    throw new ResolutionError(
      `"${query}" matches more than one ${options.noun}: ${names}. Ask which one before retrying.`,
    );
  }
  if (candidates.length === 0) {
    throw new ResolutionError(`There are no ${options.noun}s to match "${query}" against.`);
  }
  const names = candidates.map((candidate) => options.describe(candidate)).join(", ");
  throw new ResolutionError(`No ${options.noun} matches "${query}". Available: ${names}.`);
}
