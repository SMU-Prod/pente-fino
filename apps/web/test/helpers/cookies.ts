// `next/headers`'s cookies() is bound to Next's own request-scoped
// AsyncLocalStorage, which only exists inside an actual Next.js server
// request - calling it from a plain vitest process throws. Every route test
// file mocks the whole module (`vi.mock("next/headers", ...)`) and resolves
// `cookies()` to one of these instead.
//
// The jar wraps a plain Map that the test controls directly, so "the same
// browser sends a second request" is modeled by handing a *new* jar backed
// by the *same* Map to a later `cookies()` call - exactly what `jar.set()`
// in the first request already wrote is what `jar.get()` sees in the second,
// with no need to parse a Set-Cookie header out of the returned Response
// (Next's own runtime does that merge outside of any single route's code,
// so there is nothing here to intercept it from).

export type MockCookieStore = Map<string, string>;

export type MockCookieJar = {
  get(name: string): { name: string; value: string } | undefined;
  set(name: string, value: string, options?: unknown): void;
};

export function createCookieStore(initial: Record<string, string> = {}): MockCookieStore {
  return new Map(Object.entries(initial));
}

export function jarFor(store: MockCookieStore): MockCookieJar {
  return {
    get(name) {
      return store.has(name) ? { name, value: store.get(name)! } : undefined;
    },
    set(name, value) {
      store.set(name, value);
    },
  };
}
