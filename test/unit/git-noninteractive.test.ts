/**
 * Regression test for the "private clone hangs at `Username for 'https://…':`"
 * bug. git reads credential prompts from /dev/tty (not stdin), so closing stdin
 * is not enough — without GIT_TERMINAL_PROMPT=0 the unauthenticated probe clone
 * blocks on a prompt instead of failing, and the gh/glab auth retry never fires.
 *
 * These tests assert the env is present on git invocations so the failure mode
 * can never silently return.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const execaMock = vi.fn();
vi.mock("execa", () => ({
  execa: (...args: unknown[]) => execaMock(...args),
}));

// Imported after the mock is registered (vitest hoists vi.mock).
import * as git from "../../src/core/repo/git.js";

beforeEach(() => {
  execaMock.mockReset();
  execaMock.mockResolvedValue({ stdout: "", stderr: "", exitCode: 0 });
});

function optsOf(callIndex = 0): { env?: Record<string, string> } {
  const call = execaMock.mock.calls[callIndex];
  return (call?.[2] ?? {}) as { env?: Record<string, string> };
}

describe("git wrapper never prompts for credentials interactively", () => {
  it("clone() passes GIT_TERMINAL_PROMPT=0 (fail fast, don't prompt)", async () => {
    await git.clone("https://github.com/Fafoooo/repo-sync.git", "/tmp/dest");

    expect(execaMock).toHaveBeenCalledTimes(1);
    const [bin, args] = execaMock.mock.calls[0];
    expect(bin).toBe("git");
    expect(args).toEqual([
      "clone",
      "https://github.com/Fafoooo/repo-sync.git",
      "/tmp/dest",
    ]);
    expect(optsOf().env).toMatchObject({ GIT_TERMINAL_PROMPT: "0" });
  });

  it("a porcelain op (git add) also passes GIT_TERMINAL_PROMPT=0", async () => {
    await git.addAll("/tmp/dest");
    expect(optsOf().env).toMatchObject({ GIT_TERMINAL_PROMPT: "0" });
  });
});
