/**
 * Generic OAuth 2.0 Device Authorization Grant (RFC 8628).
 *
 * This is the provider-agnostic engine arbella uses to obtain an access token
 * for a git host (GitHub, GitLab, …) WITHOUT shipping a browser, a redirect
 * server, or a client secret. The flow is:
 *
 *   1. POST to the device-authorization endpoint with our client_id (+ scope).
 *      The server returns a `device_code`, a short `user_code`, a
 *      `verification_uri` the user opens in any browser, an `expires_in`, and a
 *      polling `interval`.
 *   2. We surface the verification URL + user code to the user (the CALLER does
 *      the printing via the `onPrompt` callback, so this module performs no I/O
 *      beyond `fetch`).
 *   3. We poll the token endpoint with `grant_type=
 *      urn:ietf:params:oauth:grant-type:device_code` until the user approves.
 *      Per RFC 8628 §3.5 we honor:
 *        - `authorization_pending` -> keep waiting at the current interval,
 *        - `slow_down`             -> increase the interval (by 5s, per spec),
 *        - `access_denied`         -> the user said no; fail,
 *        - `expired_token`         -> the device_code lapsed; fail,
 *        - success                 -> resolve with the access token.
 *
 * SECURITY: the resulting token is returned to the caller in memory only. This
 * module never logs it, never persists it, and never embeds it in an error
 * message. Token-at-rest is the store module's job (0600 file); token-in-URL is
 * the index module's job. The only thing this module prints is whatever the
 * caller chooses to print from the `DeviceCodePrompt` handed to `onPrompt`
 * (a verification URL + a user code — both safe to display).
 *
 * NETWORK: uses the Node 18+ global `fetch` (no node-fetch dependency). All
 * requests send `Accept: application/json` so GitHub returns JSON rather than
 * its default form-encoded body.
 *
 * LIBRARY PURITY: no system clock and no real timers are
 * read directly in a non-injectable way — the deadline is computed from an
 * injectable `now()` and the wait between polls goes through an injectable
 * `sleep()`, both defaulting to the real implementations. This keeps the poll
 * loop unit-testable (fast, deterministic) while behaving correctly in prod.
 */

/* -------------------------------------------------------------------------- */
/* Endpoint description                                                        */
/* -------------------------------------------------------------------------- */

/**
 * The two OAuth endpoints + the client_id and scopes a device flow needs. A
 * provider (see ./providers.ts) produces one of these for a given host.
 */
export interface DeviceFlowEndpoints {
  /** RFC 8628 §3.1 device authorization endpoint (issues device + user codes). */
  readonly deviceCodeUrl: string;
  /** RFC 6749 token endpoint we poll for the access token. */
  readonly tokenUrl: string;
  /** The registered OAuth App client identifier (public; not a secret). */
  readonly clientId: string;
  /** Space-joined scope string requested for the token (e.g. "repo"). */
  readonly scope: string;
}

/* -------------------------------------------------------------------------- */
/* Prompt payload surfaced to the user                                         */
/* -------------------------------------------------------------------------- */

/**
 * The user-facing half of the device flow: open `verificationUri` and type
 * `userCode`. Everything here is safe to print — none of it is a credential.
 */
export interface DeviceCodePrompt {
  /** Short, human-typed code shown on the verification page (e.g. "WDJB-MJHT"). */
  readonly userCode: string;
  /** URL the user opens in a browser to enter the code. */
  readonly verificationUri: string;
  /**
   * Optional "complete" URI that pre-fills the code (GitHub's
   * `verification_uri_complete`). When present the user can just open it.
   */
  readonly verificationUriComplete?: string;
  /** Seconds until the device/user code expires and the flow must restart. */
  readonly expiresIn: number;
}

/* -------------------------------------------------------------------------- */
/* Options                                                                     */
/* -------------------------------------------------------------------------- */

/** Injection seams (all optional; real implementations are the defaults). */
export interface DeviceFlowDeps {
  /** Fetch implementation; defaults to the global `fetch` (Node 18+). */
  readonly fetch?: typeof fetch;
  /** Monotonic-ish millisecond clock; defaults to `Date.now`. */
  readonly now?: () => number;
  /** Async delay in ms; defaults to a real `setTimeout`-backed sleep. */
  readonly sleep?: (ms: number) => Promise<void>;
}

/** Arguments for {@link runDeviceFlow}. */
export interface RunDeviceFlowArgs extends DeviceFlowDeps {
  /** The provider endpoints + client_id + scope to authenticate against. */
  readonly endpoints: DeviceFlowEndpoints;
  /**
   * Called once, as soon as the device/user code is issued, so the caller can
   * show the verification URL + user code. May be async (e.g. it might open a
   * spinner). The flow waits for it to resolve before it begins polling.
   */
  readonly onPrompt: (prompt: DeviceCodePrompt) => void | Promise<void>;
  /**
   * Optional per-poll heartbeat (e.g. to keep a spinner alive / log at debug
   * level). Never receives the token. Defaults to a no-op.
   */
  readonly onPoll?: (info: { attempt: number; waitedMs: number }) => void;
  /**
   * Optional hard cap on total wait (ms). Defaults to the server's `expires_in`.
   * Whichever is smaller wins, so we never poll past the device code's lifetime.
   */
  readonly maxWaitMs?: number;
}

/** The successful result: an access token (+ the metadata the server returned). */
export interface DeviceFlowToken {
  /** The bearer/access token. Treat as a SECRET — never log or print this. */
  readonly accessToken: string;
  /** Token type as returned (typically "bearer"). */
  readonly tokenType: string;
  /** Granted scope string, if the server echoed one. */
  readonly scope?: string;
  /** Optional refresh token (GitLab issues these; GitHub OAuth Apps do not). */
  readonly refreshToken?: string;
  /** Seconds until the access token expires, if the server provided it. */
  readonly expiresIn?: number;
}

/* -------------------------------------------------------------------------- */
/* Error type                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * A classified device-flow failure. `code` is the RFC 8628 / OAuth error code
 * when the server supplied one (e.g. "access_denied", "expired_token"), or one
 * of our synthetic codes ("timeout", "network", "http", "bad_response").
 *
 * The message is always credential-free.
 */
export class DeviceFlowError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "DeviceFlowError";
    this.code = code;
  }
}

/* -------------------------------------------------------------------------- */
/* Defaults                                                                     */
/* -------------------------------------------------------------------------- */

/** Real async delay. Kept tiny + injectable so the poll loop is testable. */
function realSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** RFC 8628 §3.5: when the server is unspecified, poll no faster than every 5s. */
const DEFAULT_INTERVAL_SECONDS = 5;
/** RFC 8628 §3.5: on `slow_down`, increase the interval by 5 seconds. */
const SLOW_DOWN_INCREMENT_SECONDS = 5;
/** Floor on the poll interval so a hostile/buggy server can't busy-loop us. */
const MIN_INTERVAL_SECONDS = 1;

/* -------------------------------------------------------------------------- */
/* Device authorization request (step 1)                                       */
/* -------------------------------------------------------------------------- */

/** Raw fields we read off the device-authorization response (snake_case wire). */
interface DeviceAuthResponse {
  device_code?: string;
  user_code?: string;
  verification_uri?: string;
  /** GitHub spells it `verification_uri`; some servers use `verification_url`. */
  verification_url?: string;
  verification_uri_complete?: string;
  expires_in?: number;
  interval?: number;
  error?: string;
  error_description?: string;
}

/**
 * Perform the device-authorization request (RFC 8628 §3.1). Returns the codes +
 * the server's recommended polling interval and expiry. Throws DeviceFlowError
 * on a transport/HTTP/parse failure or an OAuth error payload.
 */
async function requestDeviceCode(
  endpoints: DeviceFlowEndpoints,
  doFetch: typeof fetch,
): Promise<{
  deviceCode: string;
  prompt: DeviceCodePrompt;
  intervalSeconds: number;
}> {
  const body = new URLSearchParams({
    client_id: endpoints.clientId,
    scope: endpoints.scope,
  });

  const json = await postForm<DeviceAuthResponse>(
    endpoints.deviceCodeUrl,
    body,
    doFetch,
    "device authorization",
  );

  if (json.error) {
    throw new DeviceFlowError(
      json.error,
      `Device authorization was rejected: ${describeOAuthError(json.error, json.error_description)}`,
    );
  }

  const deviceCode = json.device_code;
  const userCode = json.user_code;
  const verificationUri = json.verification_uri ?? json.verification_url;

  if (!deviceCode || !userCode || !verificationUri) {
    throw new DeviceFlowError(
      "bad_response",
      "Device authorization response was missing device_code/user_code/verification_uri.",
    );
  }

  const expiresIn =
    typeof json.expires_in === "number" && json.expires_in > 0
      ? json.expires_in
      : 900; // 15 min is the common default when unspecified.

  const intervalSeconds = clampInterval(json.interval);

  const prompt: DeviceCodePrompt = {
    userCode,
    verificationUri,
    ...(json.verification_uri_complete
      ? { verificationUriComplete: json.verification_uri_complete }
      : {}),
    expiresIn,
  };

  return { deviceCode, prompt, intervalSeconds };
}

/* -------------------------------------------------------------------------- */
/* Token polling (step 3)                                                       */
/* -------------------------------------------------------------------------- */

/** Raw fields we read off the token endpoint response. */
interface TokenResponse {
  access_token?: string;
  token_type?: string;
  scope?: string;
  refresh_token?: string;
  expires_in?: number;
  error?: string;
  error_description?: string;
}

/**
 * Poll the token endpoint until the user authorizes (or we fail / time out).
 *
 * `intervalSeconds` is the starting cadence; it grows on `slow_down`. We stop
 * once `now()` passes the deadline (min of the server expiry and any caller cap)
 * and report a "timeout".
 */
async function pollForToken(args: {
  endpoints: DeviceFlowEndpoints;
  deviceCode: string;
  intervalSeconds: number;
  deadlineMs: number;
  doFetch: typeof fetch;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  onPoll: (info: { attempt: number; waitedMs: number }) => void;
}): Promise<DeviceFlowToken> {
  let intervalSeconds = args.intervalSeconds;
  let attempt = 0;
  const startedMs = args.now();

  for (;;) {
    // Respect the polling interval BEFORE each attempt (RFC 8628 §3.5 says the
    // client must wait `interval` seconds between polls).
    await args.sleep(intervalSeconds * 1000);

    if (args.now() >= args.deadlineMs) {
      throw new DeviceFlowError(
        "timeout",
        "Timed out waiting for you to authorize the device. Run the command again to retry.",
      );
    }

    attempt += 1;
    args.onPoll({ attempt, waitedMs: args.now() - startedMs });

    const body = new URLSearchParams({
      client_id: args.endpoints.clientId,
      device_code: args.deviceCode,
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
    });

    const json = await postForm<TokenResponse>(
      args.endpoints.tokenUrl,
      body,
      args.doFetch,
      "token",
    );

    // Success: the server minted a token.
    if (json.access_token) {
      return {
        accessToken: json.access_token,
        tokenType: json.token_type ?? "bearer",
        ...(json.scope ? { scope: json.scope } : {}),
        ...(json.refresh_token ? { refreshToken: json.refresh_token } : {}),
        ...(typeof json.expires_in === "number"
          ? { expiresIn: json.expires_in }
          : {}),
      };
    }

    // Otherwise we expect an OAuth error code telling us how to proceed.
    switch (json.error) {
      case "authorization_pending":
        // The user hasn't finished yet. Keep polling at the same cadence.
        continue;
      case "slow_down":
        // We're polling too fast; back off by the spec's 5-second increment.
        intervalSeconds += SLOW_DOWN_INCREMENT_SECONDS;
        continue;
      case "access_denied":
        throw new DeviceFlowError(
          "access_denied",
          "Authorization was denied. The token was not granted.",
        );
      case "expired_token":
        throw new DeviceFlowError(
          "expired_token",
          "The device code expired before you authorized it. Run the command again.",
        );
      case undefined:
        // No token AND no error code: a malformed response.
        throw new DeviceFlowError(
          "bad_response",
          "Token endpoint returned neither an access token nor an error.",
        );
      default:
        // Any other OAuth error (invalid_client, invalid_grant, unsupported…).
        throw new DeviceFlowError(
          json.error,
          `Authorization failed: ${describeOAuthError(json.error, json.error_description)}`,
        );
    }
  }
}

/* -------------------------------------------------------------------------- */
/* Public entry point                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Run the full device flow: request a code, surface it via `onPrompt`, then poll
 * until the user authorizes. Resolves with the access token (in memory) or
 * rejects with a {@link DeviceFlowError} carrying a stable `code`.
 *
 * The returned token is a SECRET: the caller must hand it to the store (0600) /
 * URL builder and must never log it.
 */
export async function runDeviceFlow(
  args: RunDeviceFlowArgs,
): Promise<DeviceFlowToken> {
  const doFetch = args.fetch ?? globalThis.fetch;
  if (typeof doFetch !== "function") {
    throw new DeviceFlowError(
      "network",
      "global fetch is unavailable; arbella requires Node 18+ for the device flow.",
    );
  }
  const now = args.now ?? Date.now;
  const sleep = args.sleep ?? realSleep;
  const onPoll = args.onPoll ?? (() => {});

  // Step 1: get the device + user code.
  const { deviceCode, prompt, intervalSeconds } = await requestDeviceCode(
    args.endpoints,
    doFetch,
  );

  // Step 2: let the caller show the verification URL + user code.
  await args.onPrompt(prompt);

  // Compute the deadline: never poll past the device code's lifetime, and honor
  // a tighter caller cap if one was given.
  const expiryMs = now() + prompt.expiresIn * 1000;
  const deadlineMs =
    args.maxWaitMs !== undefined
      ? Math.min(expiryMs, now() + args.maxWaitMs)
      : expiryMs;

  // Step 3: poll until authorized / denied / expired / timed out.
  return pollForToken({
    endpoints: args.endpoints,
    deviceCode,
    intervalSeconds,
    deadlineMs,
    doFetch,
    now,
    sleep,
    onPoll,
  });
}

/* -------------------------------------------------------------------------- */
/* Internal helpers                                                            */
/* -------------------------------------------------------------------------- */

/**
 * POST a url-encoded form and parse the JSON response. We always ask for JSON
 * (`Accept: application/json`) so GitHub does not fall back to a form-encoded
 * body. A non-2xx status that still carries a JSON OAuth error body is returned
 * to the caller (so the poll loop can read `error`); a non-2xx with no usable
 * body becomes a DeviceFlowError("http"). Network failures become
 * DeviceFlowError("network"). Parse failures become DeviceFlowError("bad_response").
 *
 * The `what` label (e.g. "token") is only used to phrase error messages; no
 * request/response bodies — which could contain a token — are ever included.
 */
async function postForm<T>(
  url: string,
  body: URLSearchParams,
  doFetch: typeof fetch,
  what: string,
): Promise<T> {
  let res: Response;
  try {
    res = await doFetch(url, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: body.toString(),
    });
  } catch (err) {
    throw new DeviceFlowError(
      "network",
      `Could not reach the ${what} endpoint (${safeHost(url)}): ${networkMessage(err)}`,
    );
  }

  // Read the body once as text, then try to parse it as JSON. Some servers send
  // a JSON error body with a non-2xx status (the OAuth poll path relies on this).
  const text = await res.text().catch(() => "");
  const parsed = tryParseJson<T>(text);

  if (parsed !== undefined) {
    return parsed;
  }

  // No JSON body we could parse. If the HTTP status was an error, surface that;
  // otherwise the server returned an unexpected (non-JSON) success body.
  if (!res.ok) {
    throw new DeviceFlowError(
      "http",
      `The ${what} endpoint (${safeHost(url)}) returned HTTP ${res.status}.`,
    );
  }
  throw new DeviceFlowError(
    "bad_response",
    `The ${what} endpoint (${safeHost(url)}) returned a response arbella could not parse.`,
  );
}

/** Parse JSON, returning undefined (never throwing) on empty/invalid input. */
function tryParseJson<T>(text: string): T | undefined {
  if (!text || text.trim() === "") return undefined;
  try {
    return JSON.parse(text) as T;
  } catch {
    return undefined;
  }
}

/** RFC 8628 §3.5 interval handling: default 5s, floor 1s, ignore junk values. */
function clampInterval(raw: number | undefined): number {
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw <= 0) {
    return DEFAULT_INTERVAL_SECONDS;
  }
  return Math.max(MIN_INTERVAL_SECONDS, Math.floor(raw));
}

/** Build a human description of an OAuth error without leaking sensitive data. */
function describeOAuthError(code: string, description?: string): string {
  const desc = typeof description === "string" ? description.trim() : "";
  return desc.length > 0 ? `${code} (${desc})` : code;
}

/** The host (scheme://host) of a URL for error messages; never the full path. */
function safeHost(url: string): string {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.host}`;
  } catch {
    return "the provider";
  }
}

/** Extract a short, safe message from a thrown fetch/network error. */
function networkMessage(err: unknown): string {
  if (err instanceof Error && err.message) return err.message;
  return String(err);
}
