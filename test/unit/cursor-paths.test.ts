import path from "node:path";

import { describe, expect, it } from "vitest";

import { cursorUserPaths } from "../../src/adapters/cursor/paths.js";

describe("Cursor paths", () => {
  it("uses XDG_CONFIG_HOME for Linux Cursor User data", () => {
    const paths = cursorUserPaths("/home/fab/.cursor", "linux", {
      XDG_CONFIG_HOME: "/mnt/config",
    });

    expect(paths.userDir).toBe(path.join("/mnt/config", "Cursor", "User"));
    expect(paths.settingsJson).toBe(path.join("/mnt/config", "Cursor", "User", "settings.json"));
  });

  it("uses APPDATA for Windows Cursor User data", () => {
    const paths = cursorUserPaths(path.join("C:", "Users", "fab", ".cursor"), "win32", {
      APPDATA: path.join("D:", "Roaming"),
    });

    expect(paths.userDir).toBe(path.join("D:", "Roaming", "Cursor", "User"));
    expect(paths.keybindingsJson).toBe(path.join("D:", "Roaming", "Cursor", "User", "keybindings.json"));
  });
});
