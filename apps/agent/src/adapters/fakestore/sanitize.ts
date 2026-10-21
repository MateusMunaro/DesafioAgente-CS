export const MAX_TITLE_CHARS = 80;
export const MAX_CATEGORY_CHARS = 40;

/**
 * Turns untrusted external text into inert data: removes control, format (zero width, bidi)
 * and markup characters, collapses whitespace and truncates. It does not try to detect
 * instructions; the text is later passed to the LLM only inside <dados_externos>.
 */
export function sanitizeText(input: string, maxChars: number): string {
  const cleaned = input
    .normalize("NFKC")
    .replace(/\p{Cf}/gu, "")
    .replace(/[\p{Cc}\p{Zl}\p{Zp}]/gu, " ")
    .replace(/[<>`{}[\]\\|]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return truncate(cleaned, maxChars);
}

function truncate(s: string, maxChars: number): string {
  const chars = Array.from(s);
  if (chars.length <= maxChars) return s;
  return chars.slice(0, maxChars - 1).join("").trimEnd() + "…";
}
