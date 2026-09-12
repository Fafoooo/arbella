const path = require("node:path");

module.exports = {
  branches: ["main"],
  tagFormat: "v${version}",
  plugins: [
    [path.join(__dirname, "analyze-commits.mjs"), { preset: "conventionalcommits" }],
    [require.resolve("@semantic-release/release-notes-generator"), { preset: "conventionalcommits" }],
    require.resolve("@semantic-release/npm"),
    [require.resolve("@semantic-release/github"), {
      successComment: false,
      failComment: false,
      failTitle: false,
      releasedLabels: false,
    }],
  ],
};
