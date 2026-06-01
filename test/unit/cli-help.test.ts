import fs from "node:fs";

import { describe, expect, it } from "vitest";

import { buildProgram } from "../../src/index.js";
import { getPackageVersion } from "../../src/core/version.js";

describe("CLI help", () => {
  it("uses the package.json version", () => {
    const packageJson = JSON.parse(
      fs.readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
    ) as { version: string };

    expect(getPackageVersion()).toBe(packageJson.version);
    expect(buildProgram().version()).toBe(packageJson.version);
  });

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

  it("registers the public update command", () => {
    const program = buildProgram();
    const update = program.commands.find((command) => command.name() === "update");

    expect(update).toBeDefined();
    expect(update?.description()).toContain("Update arbella");
    expect(update?.helpInformation()).toContain("--version <version>");
  });
});
