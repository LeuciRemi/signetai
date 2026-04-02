/**
 * Shared BPE tokenizer utilities.
 *
 * Uses cl100k_base (GPT-4 / Claude vocabulary), which is a close enough
 * approximation for all major hosted LLM APIs and far more accurate than
 * the length/4 character heuristic.
 *
 * The Tiktoken instance is initialised once at module load and shared across
 * all callers (dreaming, summary-worker, memory-head) so we only pay the
 * vocabulary-load cost once per daemon process.
 */

import { Tiktoken } from "js-tiktoken/lite";
import cl100k_base from "js-tiktoken/ranks/cl100k_base";

const tok = new Tiktoken(cl100k_base);

/** Count the BPE tokens in `text`. */
export function countTokens(text: string): number {
	return tok.encode(text).length;
}

/**
 * Truncate `text` to at most `limit` tokens, preserving token boundaries
 * so the result is always valid UTF-8.  Returns an empty string when
 * `limit < 1`.
 */
export function truncateToTokens(text: string, limit: number): string {
	if (limit < 1) return "";
	const tokens = tok.encode(text);
	if (tokens.length <= limit) return text;
	return tok.decode(tokens.slice(0, limit)).trimEnd();
}
