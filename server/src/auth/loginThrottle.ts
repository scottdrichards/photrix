/**
 * Limits on password login, which is unauthenticated and costs a scrypt hash.
 *
 * Two independent limits, because neither is enough alone:
 *
 * - **A global cap on hashes in flight.** Each hash runs on libuv's small
 *   thread pool, which file and DNS I/O share, so a flood of logins could still
 *   stall the site after the hash left the event loop. Past the cap a login
 *   waits in a short queue; past the queue it is refused.
 * - **A failure budget per client IP.** The IP comes from `X-Forwarded-For`,
 *   and behind the tunnel every outside visitor may share one address, so this
 *   budget is generous and only slows guessing; the global cap is what keeps
 *   the site up.
 */

const MAX_CONCURRENT_HASHES = Number(process.env.PHOTRIX_LOGIN_MAX_CONCURRENT) || 2;
const MAX_QUEUED_LOGINS = Number(process.env.PHOTRIX_LOGIN_MAX_QUEUED) || 16;
const FAILURE_WINDOW_MS = 15 * 60_000;
const MAX_FAILURES_PER_WINDOW = Number(process.env.PHOTRIX_LOGIN_MAX_FAILURES) || 20;

export class LoginThrottledError extends Error {
  constructor(readonly retryAfterSeconds: number) {
    super("Too many login attempts");
  }
}

let hashesInFlight = 0;
const waiting: Array<() => void> = [];

const acquireHashSlot = async (): Promise<void> => {
  if (hashesInFlight < MAX_CONCURRENT_HASHES) {
    hashesInFlight++;
    return;
  }
  if (waiting.length >= MAX_QUEUED_LOGINS) {
    throw new LoginThrottledError(5);
  }
  // The slot is handed over directly on release, so the count stays put.
  await new Promise<void>((resolve) => waiting.push(resolve));
};

const releaseHashSlot = (): void => {
  const next = waiting.shift();
  if (next) {
    next();
  } else {
    hashesInFlight--;
  }
};

type FailureWindow = { startedAt: number; failures: number };
const failuresByClient = new Map<string, FailureWindow>();

const currentWindow = (client: string, now: number): FailureWindow | undefined => {
  const window = failuresByClient.get(client);
  if (window && now - window.startedAt >= FAILURE_WINDOW_MS) {
    failuresByClient.delete(client);
    return undefined;
  }
  return window;
};

const recordFailure = (client: string, now: number): void => {
  const window = currentWindow(client, now);
  if (window) {
    window.failures++;
    return;
  }
  // Drop expired windows as new ones open, so the map stays bounded by the
  // number of clients seen in the last window.
  for (const [key, entry] of failuresByClient) {
    if (now - entry.startedAt >= FAILURE_WINDOW_MS) failuresByClient.delete(key);
  }
  failuresByClient.set(client, { startedAt: now, failures: 1 });
};

/**
 * Runs one credential check under both limits. `check` resolves to the session
 * token, or null for wrong credentials (which counts against the client).
 */
export const throttleLogin = async (
  clientIp: string | null,
  check: () => Promise<string | null>,
): Promise<string | null> => {
  const client = clientIp ?? "unknown";
  const now = Date.now();
  const window = currentWindow(client, now);
  if (window && window.failures >= MAX_FAILURES_PER_WINDOW) {
    throw new LoginThrottledError(
      Math.ceil((window.startedAt + FAILURE_WINDOW_MS - now) / 1000),
    );
  }

  await acquireHashSlot();
  try {
    const token = await check();
    if (token === null) recordFailure(client, Date.now());
    return token;
  } finally {
    releaseHashSlot();
  }
};

/** For tests. */
export const resetLoginThrottle = (): void => {
  failuresByClient.clear();
};
