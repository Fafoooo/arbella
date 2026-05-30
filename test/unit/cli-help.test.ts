import { describe, expect, it } from "vitest";

import { buildProgram } from "../../src/index.js";

describe("CLI help", () => {
  it("shows auto-push as the public init cadence flag and keeps auto-backup hidden", () => {
    const program = buildProgram();
    const init = program.commands.find((command) => command.name() === "init");

    expect(init).toBeDefined();
    expect(init?.helpInformation()).toContain("--auto-push <mode>");
    expect(init?.helpInformation()).not.toContain("--auto-backup <mode>");
    expect(init?.helpInformation()).toContain("--no-push");
    expect(init?.helpInformation()).not.toContain("--no-backup");
    expect(init?.options.map((option) => option.long)).toContain("--auto-backup");
    expect(init?.options.map((option) => option.long)).toContain("--no-backup");
  });
});
