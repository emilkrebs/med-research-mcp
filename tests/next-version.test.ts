import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { nextVersion, shippedPaths } from "../scripts/next-version.mjs";

const sha = "b28f2da0c1e5d9b3f2a4c6e8d0b1a3c5e7f9a1b2";

describe("next release version", () => {
  it("is a pre-release of the patch after the last release when package.json is at that release", () => {
    expect(nextVersion({ packageVersion: "0.8.0", lastRelease: "v0.8.0", commitsSince: 2, sha })).toBe(
      "0.8.1-next.2.gb28f2da",
    );
  });

  it("is a pre-release of the version package.json names when that's ahead of the last release", () => {
    expect(nextVersion({ packageVersion: "0.9.0", lastRelease: "v0.8.0", commitsSince: 5, sha })).toBe(
      "0.9.0-next.5.gb28f2da",
    );
    expect(nextVersion({ packageVersion: "1.0.0-next.1", lastRelease: "v0.8.0", commitsSince: 5, sha })).toBe(
      "1.0.0-next.5.gb28f2da",
    );
  });

  it("never sorts at or below the last release, even when package.json is behind it", () => {
    expect(nextVersion({ packageVersion: "0.8.0-next.3", lastRelease: "v0.8.0", commitsSince: 0, sha })).toBe(
      "0.8.1-next.0.gb28f2da",
    );
    expect(nextVersion({ packageVersion: "0.7.2", lastRelease: "v0.8.0", commitsSince: 1, sha })).toBe(
      "0.8.1-next.1.gb28f2da",
    );
  });

  it("keeps a commit whose short hash is all digits a valid semver identifier", () => {
    // "0123456" alone would be a numeric identifier with a leading zero.
    expect(nextVersion({ packageVersion: "0.8.0", lastRelease: "v0.8.0", commitsSince: 1, sha: "0123456789" })).toBe(
      "0.8.1-next.1.g0123456",
    );
  });

  it("rejects a tag that isn't a version", () => {
    expect(() => nextVersion({ packageVersion: "0.8.0", lastRelease: "latest", commitsSince: 1, sha })).toThrow();
  });
});

describe("paths that ship", () => {
  it("are package.json's files without the build output, plus what builds it", () => {
    const { files } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf-8"));
    const paths = shippedPaths(files);
    expect(paths).toEqual(expect.arrayContaining(["src", "skills", "package.json", "tsup.config.ts"]));
    expect(paths.filter((p: string) => p.startsWith("dist"))).toEqual([]);
  });
});
