import { describe, expect, it, vi } from "vitest";

const gitMocks = vi.hoisted(() => ({
  hasUpstream: vi.fn(async () => true),
  pull: vi.fn(async () => {
    throw new Error("remote: \u001b[31mfake error\u001b[0m\nrejected");
  }),
  abortRebase: vi.fn(async () => undefined),
}));
vi.mock("../../src/core/repo/git.js", () => gitMocks);

import { syncBeforePush } from "../../src/core/repo/index.js";

describe("syncBeforePush", () => {
  it("strips control characters from the git cause", async () => {
    const err = await syncBeforePush({ provider: "generic", url: "", localPath: "/x" }).catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain("Nothing was pushed");
    expect((err as Error).message).toContain("fake error");
    expect((err as Error).message).not.toMatch(/\p{C}/u);
  });
});
