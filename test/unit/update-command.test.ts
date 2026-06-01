import { beforeEach, describe, expect, it, vi } from "vitest";

const installCalls: string[] = [];

vi.mock("../../src/platform/install.js", () => ({
  npmInstallGlobal: async (pkg: string) => {
    installCalls.push(pkg);
  },
}));

describe("update command", () => {
  beforeEach(() => {
    installCalls.length = 0;
  });

  it("updates arbella to latest by default", async () => {
    const { run } = await import("../../src/commands/update.js");

    await run({});

    expect(installCalls).toEqual(["arbella@latest"]);
  });

  it("updates arbella to a requested version", async () => {
    const { run } = await import("../../src/commands/update.js");

    await run({ version: "0.1.2" });

    expect(installCalls).toEqual(["arbella@0.1.2"]);
  });

  it("does not install anything in dry-run mode", async () => {
    const { run } = await import("../../src/commands/update.js");

    await run({ dryRun: true });

    expect(installCalls).toEqual([]);
  });
});
