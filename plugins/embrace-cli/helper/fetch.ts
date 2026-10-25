// Injectable fetch for the helper's OAuth and tRPC HTTP calls. Production code
// uses the global fetch; tests replace it with a stub so no live server is ever
// contacted (constraint: localhost stubs only during build and test).
// Usage: `import { httpFetch } from './fetch'` at call sites;
//        tests call `setFetchForTests(stub)`.

type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

let currentFetch: FetchLike = (input, init) => fetch(input, init);

/** The fetch implementation OAuth/tRPC calls go through. */
export function httpFetch(input: string | URL, init?: RequestInit): Promise<Response> {
  return currentFetch(input, init);
}

/** Replace fetch in tests. Pass nothing to restore the global fetch. */
export function setFetchForTests(impl?: FetchLike): void {
  currentFetch = impl ?? ((input, init) => fetch(input, init));
}
