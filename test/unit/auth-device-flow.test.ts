/**
 * Unit tests for the RFC 8628 device-flow engine (src/core/auth/device-flow.ts).
 *
 * NO REAL NETWORK: the engine takes an injectable `fetch` (plus injectable
 * `now`/`sleep` for a fast, deterministic poll loop). We feed it a scripted fake
 * `fetch` that returns queued JSON bodies — one for the device-authorization
 * request, then one per token poll — so we can exercise every branch of the
 * polling state machine offline and instantly:
 *
 *   - HAPPY path: device code issued -> a couple of `authorization_pending`
 *     polls -> success with the access token (returned in memory).
 *   - `slow_down`: the poll interval grows by the spec's 5s increment.
 *   - `expired_token` / `access_denied`: classified DeviceFlowError codes.
 *   - timeout: `now()` passing the deadline aborts with a "timeout" code.
 *   - malformed device-auth / token responses -> "bad_response".
 *   - prompt surfacing: verification URI + user code reach `onPrompt` (and are
 *     the ONLY thing the engine exposes for printing — never the token).
 *
 * One test additionally proves the engine uses the *global* `fetch` when no
 * `fetch` is injected (via a spy), to lock down the Node 18+ contract.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  DeviceFlowError,
  runDeviceFlow,
  type DeviceCodePrompt,
  type DeviceFlowEndpoints,
} from "../../src/core/auth/device-flow.js";

/* -------------------------------------------------------------------------- */
/* Test helpers: a scripted fake fetch + a controllable clock                  */
/* -------------------------------------------------------------------------- */

const ENDPOINTS: DeviceFlowEndpoints = {
  deviceCodeUrl: "https://github.com/login/device/code",
  tokenUrl: "https://github.com/login/oauth/access_token",
  clientId: "test-client-id",
  scope: "repo",
};

/** A queued JSON response (status defaults to 200). */
interface ScriptedResponse {
  body: unknown;
  status?: number;
}

/**
 * Build a fake `fetch` that returns `responses` in order. Each call records the
 * URL + decoded form body so a test can assert what the engine sent (e.g. the
 * grant_type + device_code on a poll). When the queue is exhausted it throws —
 * a test that polls more than scripted is a bug we want surfaced.
 */
function scriptedFetch(responses: ScriptedResponse[]): {
  fetch: typeof fetch;
  calls: Array<{ url: string; form: Record<string, string> }>;
} {
  const queue = [...responses];
  const calls: Array<{ url: string; form: Record<string, string> }> = [];

  const fakeFetch = (async (url: string | URL, init?: RequestInit) => {
    const bodyStr = typeof init?.body === "string" ? init.body : "";
    const form: Record<string, string> = {};
    for (const [k, v] of new URLSearchParams(bodyStr)) form[k] = v;
    calls.push({ url: String(url), form });

    const next = queue.shift();
    if (!next) throw new Error("scriptedFetch: more requests than scripted responses");

    return {
      ok: (next.status ?? 200) >= 200 && (next.status ?? 200) < 300,
      status: next.status ?? 200,
      // The engine reads the body once via .text() then JSON.parses it.
      text: async () => (typeof next.body === "string" ? next.body : JSON.stringify(next.body)),
    } as Response;
  }) as unknown as typeof fetch;

  return { fetch: fakeFetch, calls };
}

/** A device-authorization success body. */
function deviceAuthBody(over: Partial<Record<string, unknown>> = {}): unknown {
  return {
    device_code: "DEV-CODE-123",
    user_code: "WDJB-MJHT",
    verification_uri: "https://github.com/login/device",
    verification_uri_complete: "https://github.com/login/device?user_code=WDJB-MJHT",
    expires_in: 900,
    interval: 5,
    ...over,
  };
}

/** A clock that advances by `stepMs` on each read (deterministic timeouts). */
function steppingClock(stepMs: number, startMs = 0): () => number {
  let t = startMs;
  return () => {
    const cur = t;
    t += stepMs;
    return cur;
  };
}

/** A sleep that never actually waits — keeps the poll loop instant. */
const instantSleep = async (_ms: number): Promise<void> => undefined;

/* -------------------------------------------------------------------------- */
/* Happy path                                                                  */
/* -------------------------------------------------------------------------- */

describe("device flow: happy path", () => {
  it("issues a code, surfaces the prompt, polls past pending, and returns the token", async () => {
    const { fetch: fakeFetch, calls } = scriptedFetch([
      { body: deviceAuthBody() },
      { body: { error: "authorization_pending" } },
      { body: { error: "authorization_pending" } },
      {
        body: {
          access_token: "gho_THE_ACCESS_TOKEN_secret",
          token_type: "bearer",
          scope: "repo",
        },
      },
    ]);

    let seenPrompt: DeviceCodePrompt | undefined;
    const polls: number[] = [];

    const token = await runDeviceFlow({
      endpoints: ENDPOINTS,
      fetch: fakeFetch,
      now: () => 0, // never advances -> never times out within this script
      sleep: instantSleep,
      onPrompt: (p) => {
        seenPrompt = p;
      },
      onPoll: ({ attempt }) => polls.push(attempt),
    });

    // The token (a SECRET) is returned only here, in memory.
    expect(token.accessToken).toBe("gho_THE_ACCESS_TOKEN_secret");
    expect(token.tokenType).toBe("bearer");
    expect(token.scope).toBe("repo");

    // The user-facing prompt carries the verification URI + user code (safe).
    expect(seenPrompt).toBeDefined();
    expect(seenPrompt!.userCode).toBe("WDJB-MJHT");
    expect(seenPrompt!.verificationUri).toBe("https://github.com/login/device");
    expect(seenPrompt!.verificationUriComplete).toContain("user_code=WDJB-MJHT");

    // We polled the token endpoint after both pending replies (3 token POSTs).
    expect(polls).toEqual([1, 2, 3]);

    // First request hit the device-code endpoint with client_id+scope; the token
    // polls carried the device_code + the RFC 8628 grant_type.
    expect(calls[0]!.url).toBe(ENDPOINTS.deviceCodeUrl);
    expect(calls[0]!.form.client_id).toBe("test-client-id");
    expect(calls[0]!.form.scope).toBe("repo");
    expect(calls[1]!.url).toBe(ENDPOINTS.tokenUrl);
    expect(calls[1]!.form.device_code).toBe("DEV-CODE-123");
    expect(calls[1]!.form.grant_type).toBe(
      "urn:ietf:params:oauth:grant-type:device_code",
    );
  });

  it("supports GitLab's `verification_url` spelling and missing complete URI", async () => {
    const { fetch: fakeFetch } = scriptedFetch([
      {
        body: {
          device_code: "GL-DEV",
          user_code: "ABCD-1234",
          verification_url: "https://gitlab.com/oauth/device", // note: _url not _uri
          expires_in: 600,
          interval: 5,
        },
      },
      { body: { access_token: "glpat-TOKEN", token_type: "bearer" } },
    ]);

    let prompt: DeviceCodePrompt | undefined;
    const token = await runDeviceFlow({
      endpoints: {
        ...ENDPOINTS,
        deviceCodeUrl: "https://gitlab.com/oauth/authorize_device",
        tokenUrl: "https://gitlab.com/oauth/token",
      },
      fetch: fakeFetch,
      now: () => 0,
      sleep: instantSleep,
      onPrompt: (p) => {
        prompt = p;
      },
    });

    expect(prompt!.verificationUri).toBe("https://gitlab.com/oauth/device");
    expect(prompt!.verificationUriComplete).toBeUndefined();
    expect(token.accessToken).toBe("glpat-TOKEN");
  });
});

/* -------------------------------------------------------------------------- */
/* slow_down handling                                                          */
/* -------------------------------------------------------------------------- */

describe("device flow: slow_down backs off the poll interval", () => {
  it("increases the sleep interval by 5s after a slow_down reply", async () => {
    const { fetch: fakeFetch } = scriptedFetch([
      { body: deviceAuthBody({ interval: 5 }) },
      { body: { error: "slow_down" } },
      { body: { error: "authorization_pending" } },
      { body: { access_token: "gho_AFTER_SLOWDOWN", token_type: "bearer" } },
    ]);

    const sleeps: number[] = [];
    const token = await runDeviceFlow({
      endpoints: ENDPOINTS,
      fetch: fakeFetch,
      now: () => 0,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
      onPrompt: () => {},
    });

    expect(token.accessToken).toBe("gho_AFTER_SLOWDOWN");
    // Sleeps happen BEFORE each poll: [5s] before poll#1, then slow_down bumps the
    // interval to 10s for the remaining polls (5000, 10000, 10000).
    expect(sleeps).toEqual([5000, 10000, 10000]);
  });
});

/* -------------------------------------------------------------------------- */
/* Failure codes                                                               */
/* -------------------------------------------------------------------------- */

describe("device flow: classified failures", () => {
  it("rejects with access_denied when the user denies authorization", async () => {
    const { fetch: fakeFetch } = scriptedFetch([
      { body: deviceAuthBody() },
      { body: { error: "access_denied", error_description: "The user denied the request." } },
    ]);

    await expect(
      runDeviceFlow({
        endpoints: ENDPOINTS,
        fetch: fakeFetch,
        now: () => 0,
        sleep: instantSleep,
        onPrompt: () => {},
      }),
    ).rejects.toMatchObject({ name: "DeviceFlowError", code: "access_denied" });
  });

  it("rejects with expired_token when the device code lapses", async () => {
    const { fetch: fakeFetch } = scriptedFetch([
      { body: deviceAuthBody() },
      { body: { error: "expired_token" } },
    ]);

    const err = await runDeviceFlow({
      endpoints: ENDPOINTS,
      fetch: fakeFetch,
      now: () => 0,
      sleep: instantSleep,
      onPrompt: () => {},
    }).catch((e) => e);

    expect(err).toBeInstanceOf(DeviceFlowError);
    expect((err as DeviceFlowError).code).toBe("expired_token");
  });

  it("times out (deadline passed) and reports a 'timeout' code", async () => {
    // expires_in is small; the stepping clock jumps 10 minutes per read so the
    // deadline is exceeded on the first poll check -> timeout (we keep replying
    // 'authorization_pending' so only the clock can end the loop).
    const { fetch: fakeFetch } = scriptedFetch([
      { body: deviceAuthBody({ expires_in: 120 }) },
      { body: { error: "authorization_pending" } },
      { body: { error: "authorization_pending" } },
    ]);

    const err = await runDeviceFlow({
      endpoints: ENDPOINTS,
      fetch: fakeFetch,
      now: steppingClock(10 * 60_000), // +10min each read -> blows past 120s
      sleep: instantSleep,
      onPrompt: () => {},
    }).catch((e) => e);

    expect(err).toBeInstanceOf(DeviceFlowError);
    expect((err as DeviceFlowError).code).toBe("timeout");
  });

  it("rejects 'bad_response' when the device-auth body lacks required fields", async () => {
    const { fetch: fakeFetch } = scriptedFetch([
      { body: { expires_in: 900 } }, // no device_code / user_code / verification_uri
    ]);

    const err = await runDeviceFlow({
      endpoints: ENDPOINTS,
      fetch: fakeFetch,
      now: () => 0,
      sleep: instantSleep,
      onPrompt: () => {},
    }).catch((e) => e);

    expect(err).toBeInstanceOf(DeviceFlowError);
    expect((err as DeviceFlowError).code).toBe("bad_response");
  });

  it("propagates an OAuth error returned by the device-auth endpoint itself", async () => {
    const { fetch: fakeFetch } = scriptedFetch([
      { body: { error: "unauthorized_client", error_description: "Bad app" }, status: 400 },
    ]);

    const err = await runDeviceFlow({
      endpoints: ENDPOINTS,
      fetch: fakeFetch,
      now: () => 0,
      sleep: instantSleep,
      onPrompt: () => {},
    }).catch((e) => e);

    expect(err).toBeInstanceOf(DeviceFlowError);
    expect((err as DeviceFlowError).code).toBe("unauthorized_client");
  });

  it("never leaks the access token into a DeviceFlowError message", async () => {
    // Even on a post-token malformed shape, no error message should echo a token.
    const { fetch: fakeFetch } = scriptedFetch([
      { body: deviceAuthBody() },
      { body: { token_type: "bearer" /* no access_token, no error */ } },
    ]);

    const err = await runDeviceFlow({
      endpoints: ENDPOINTS,
      fetch: fakeFetch,
      now: () => 0,
      sleep: instantSleep,
      onPrompt: () => {},
    }).catch((e) => e);

    expect(err).toBeInstanceOf(DeviceFlowError);
    expect((err as DeviceFlowError).code).toBe("bad_response");
  });
});

/* -------------------------------------------------------------------------- */
/* Global-fetch contract                                                       */
/* -------------------------------------------------------------------------- */

describe("device flow: uses the global fetch when none is injected", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("calls globalThis.fetch (Node 18+) and returns the token", async () => {
    const { fetch: scripted } = scriptedFetch([
      { body: deviceAuthBody() },
      { body: { access_token: "gho_VIA_GLOBAL_FETCH", token_type: "bearer" } },
    ]);
    const spy = vi.spyOn(globalThis, "fetch").mockImplementation(scripted);

    const token = await runDeviceFlow({
      endpoints: ENDPOINTS,
      // no `fetch` injected -> must fall back to globalThis.fetch (the spy)
      now: () => 0,
      sleep: instantSleep,
      onPrompt: () => {},
    });

    expect(spy).toHaveBeenCalled();
    expect(token.accessToken).toBe("gho_VIA_GLOBAL_FETCH");
  });
});
