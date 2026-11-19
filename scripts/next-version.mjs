#!/usr/bin/env node
/**
 * Picks the version for an automatic next release of the commit checked out, or
 * decides there shouldn't be one. publish.yml runs it once CI has passed on a push
 * to main.
 *
 * The version is `<base>-next.<n>.g<sha>`, for example 0.8.1-next.2.gb28f2da:
 * - base: the version in package.json if it's ahead of the last release (main
 *   carries the bump for a release that isn't out yet), otherwise the patch after
 *   the last release. Either way the build sorts above the last release and below
 *   the next one;
 * - n: the number of commits since the last release, so builds sort in commit order;
 * - sha: the commit, after a `g` as in `git describe`. Seven hex digits can all be
 *   digits, and a numeric identifier with a leading zero isn't valid semver.
 * The last release is the newest `v<x.y.z>` tag in the commit's history.
 * Pre-release tags don't count.
 *
 * There's no next release when main has moved past the commit (the newer commit's
 * own run publishes that one), or when nothing that ships has changed since the
 * commit the current `next` build came from, e.g. a docs-only commit or a re-run.
 *
 * Prints what it decided, and in GitHub Actions writes `version=<version>` to
 * $GITHUB_OUTPUT, or `version=` when there's nothing to publish.
 *
 * Usage: node scripts/next-version.mjs
 */

import { execFileSync, spawnSync } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** The `[major, minor, patch]` of a version or `v` tag, ignoring any pre-release or build suffix. */
function core(version) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(version);
  if (!match) throw new Error(`Not a version: ${version}`);
  return match.slice(1, 4).map(Number);
}

/** The next-release version; see the comment at the top. */
export function nextVersion({ packageVersion, lastRelease, commitsSince, sha }) {
  const pkg = core(packageVersion);
  const last = core(lastRelease);
  const ahead = pkg[0] - last[0] || pkg[1] - last[1] || pkg[2] - last[2];
  const base = ahead > 0 ? pkg : [last[0], last[1], last[2] + 1];
  return `${base.join(".")}-next.${commitsSince}.g${sha.slice(0, 7)}`;
}

/**
 * The paths whose changes reach the package: the `files` of package.json other
 * than the build output, package.json itself, and what dist/ is built with.
 */
export function shippedPaths(files) {
  const sources = files.filter((file) => file !== "dist" && !file.startsWith("dist/"));
  return [...sources, "package.json", "package-lock.json", "tsconfig.json", "tsup.config.ts"];
}

function git(...args) {
  return execFileSync("git", args, { cwd: root, encoding: "utf-8" }).trim();
}

/** The exit status of a git command run for its answer, not its output. */
function gitStatus(...args) {
  const { status, error } = spawnSync("git", args, { cwd: root, stdio: "ignore" });
  if (error) throw error;
  return status;
}

/** The commit the package's current `next` build was published from, if npm recorded one. */
function nextBuildCommit(name) {
  try {
    return execFileSync("npm", ["view", `${name}@next`, "gitHead"], { cwd: root, encoding: "utf-8" }).trim() || undefined;
  } catch {
    return undefined; // no `next` dist-tag yet
  }
}

function decide() {
  const head = git("rev-parse", "HEAD");
  const tip = git("ls-remote", "--exit-code", "origin", "refs/heads/main").split(/\s/)[0];
  if (head !== tip) return { reason: `main has moved on to ${tip.slice(0, 7)}, whose own run publishes it.` };

  const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf-8"));
  const built = nextBuildCommit(pkg.name);
  if (built && gitStatus("cat-file", "-e", `${built}^{commit}`) === 0) {
    const status = gitStatus("diff", "--quiet", built, head, "--", ...shippedPaths(pkg.files));
    if (status === 0) return { reason: `nothing that ships has changed since ${built.slice(0, 7)}, the commit of the current next build.` };
    if (status !== 1) throw new Error(`git diff exited with ${status}.`);
  }

  const lastRelease = git("describe", "--tags", "--abbrev=0", "--match", "v[0-9]*", "--exclude", "*-*", head);
  const commitsSince = Number(git("rev-list", "--count", `${lastRelease}..${head}`));
  return { version: nextVersion({ packageVersion: pkg.version, lastRelease, commitsSince, sha: head }) };
}

function main() {
  const { version, reason } = decide();
  console.log(version ? `Next release: ${version}` : `No next release: ${reason}`);
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `version=${version ?? ""}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
