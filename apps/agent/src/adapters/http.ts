export type FetchOutcome =
  | { kind: "response"; status: number; body: unknown; bodyValid: boolean }
  | { kind: "timeout" }
  | { kind: "network" };

export interface FetchOptions {
  fetchImpl: typeof fetch;
  timeoutMs: number;
  method: string;
  headers: Record<string, string>;
  body?: string;
}

/** fetch with an AbortController deadline covering headers and body. Never throws. */
export async function fetchJson(url: string, o: FetchOptions): Promise<FetchOutcome> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), o.timeoutMs);
  try {
    const res = await o.fetchImpl(url, { method: o.method, headers: o.headers, body: o.body, signal: controller.signal });
    const text = await res.text();
    try {
      return { kind: "response", status: res.status, body: JSON.parse(text), bodyValid: true };
    } catch {
      return { kind: "response", status: res.status, body: undefined, bodyValid: false };
    }
  } catch {
    return controller.signal.aborted ? { kind: "timeout" } : { kind: "network" };
  } finally {
    clearTimeout(timer);
  }
}

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
