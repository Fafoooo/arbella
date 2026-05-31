import { describe, expect, it } from "vitest";

import { normalizeCapturedSymlinkTarget } from "../../src/utils/symlink.js";

describe("normalizeCapturedSymlinkTarget", () => {
  it("serializes relative symlink targets with POSIX separators", () => {
    expect(normalizeCapturedSymlinkTarget("..\\..\\.agents\\skills\\humanizer")).toBe(
      "../../.agents/skills/humanizer",
    );
  });

  it("leaves already-POSIX targets unchanged", () => {
    expect(normalizeCapturedSymlinkTarget("../../.agents/skills/humanizer")).toBe(
      "../../.agents/skills/humanizer",
    );
  });
});
