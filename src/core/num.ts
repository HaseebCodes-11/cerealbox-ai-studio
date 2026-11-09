/**
 * Numeric helpers shared across areas (DEBT-01). Before this module the same
 * three-line rounding functions were defined privately in five files.
 */

/** Round to `decimals` places (default 3) using the same `Math.round(n * k) / k` the areas always used. */
export function round(n: number, decimals = 3): number {
  const k = 10 ** decimals;
  return Math.round(n * k) / k;
}

/** Two-decimal rounding for money and percentages. */
export function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** Zero-pad an integer to two digits (timecodes). */
export function pad2(n: number): string {
  return String(n).padStart(2, "0");
}
