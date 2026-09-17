import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  chmod,
  mkdtemp,
  readFile,
  readdir,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  ensureYouTubeCLI,
  findYouTubeCLI,
  youTubeCLI,
} from "../packages/orchestrator/src/youtube.ts";
import { StudioError } from "../packages/shared/src/index.ts";

const run = promisify(execFile);

const ASSET_NAME = `youtubeuploader_1.25.5_${
  process.platform === "darwin" ? "Darwin" : "Linux"
}_${process.arch === "x64" ? "amd64" : "arm64"}.tar.gz`;

/** A real tar.gz shaped like the official release: binary + README + LICENSE. */
async function releaseArchive() {
  const build = await mkdtemp(path.join(tmpdir(), "wts-release-"));
  await writeFile(
    path.join(build, "youtubeuploader"),
    "#!/bin/sh\necho youtubeuploader-ok\n",
  );
  await writeFile(path.join(build, "README.md"), "upload helper\n");
  await writeFile(path.join(build, "LICENSE"), "MIT\n");
  const archive = path.join(build, ASSET_NAME);
  await run("/usr/bin/tar", [
    "-czf",
    archive,
    "-C",
    build,
    "youtubeuploader",
    "README.md",
    "LICENSE",
  ]);
  const bytes = await readFile(archive);
  return { bytes, sha256: createHash("sha256").update(bytes).digest("hex") };
}

/** Fake api.github.com plus the release download it points at. */
function github(
  bytes: Buffer,
  options: {
    digest?: string;
    apiStatus?: number;
    downloadStatus?: number;
  } = {},
) {
  const calls: string[] = [];
  const fetch = (async (url: string | URL | RequestInfo) => {
    const href = String(url);
    calls.push(href);
    if (href.includes("/releases/tags/")) {
      if (options.apiStatus && options.apiStatus !== 200)
        return new Response("rate limited", { status: options.apiStatus });
      return new Response(
        JSON.stringify({
          tag_name: "v1.25.5",
          assets: [
            {
              name: ASSET_NAME,
              browser_download_url: `https://github.example/download/${ASSET_NAME}`,
              digest:
                options.digest ??
                `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
              size: bytes.byteLength,
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    if (href.endsWith(ASSET_NAME)) {
      if (options.downloadStatus && options.downloadStatus !== 200)
        return new Response("gone", { status: options.downloadStatus });
      return new Response(new Uint8Array(bytes), { status: 200 });
    }
    return new Response("unexpected request", { status: 500 });
  }) as typeof globalThis.fetch;
  return { fetch, calls };
}

const installDir = async () => mkdtemp(path.join(tmpdir(), "wts-cli-"));
const noDiscovery = async () => null;

test("ensureYouTubeCLI installs the pinned release, verifies it, and never refetches", async () => {
  const dir = await installDir();
  const { bytes } = await releaseArchive();
  const { fetch, calls } = github(bytes);
  const cli = await ensureYouTubeCLI({
    installDir: dir,
    discover: noDiscovery,
    transport: { fetch },
  });
  assert.equal(cli, path.join(dir, "youtubeuploader"));
  // Extracted from a real archive, so the shell stub must be intact and executable.
  const mode = (await stat(cli)).mode;
  assert.ok(mode & 0o111, "the installed CLI must be executable");
  assert.match((await readFile(cli, "utf8")).trim(), /youtubeuploader-ok/);
  assert.deepEqual(
    await readdir(dir),
    ["youtubeuploader"],
    "no archive or staging leftovers may remain",
  );
  assert.equal(calls.filter((c) => c.endsWith(ASSET_NAME)).length, 1);
  calls.length = 0;
  await ensureYouTubeCLI({
    installDir: dir,
    discover: noDiscovery,
    transport: { fetch },
  });
  assert.equal(calls.length, 0, "an installed CLI must not be re-downloaded");
});

test("an existing discovery result wins without touching the network", async () => {
  const { bytes } = await releaseArchive();
  const { fetch, calls } = github(bytes);
  const mine = path.join(await installDir(), "mine");
  await writeFile(mine, "#!/bin/sh\n");
  await chmod(mine, 0o755);
  const cli = await ensureYouTubeCLI({
    discover: async () => mine,
    transport: { fetch },
  });
  assert.equal(cli, mine);
  assert.equal(calls.length, 0);
});

test("checksum mismatches are rejected and leave the cache empty", async () => {
  const dir = await installDir();
  const { bytes } = await releaseArchive();
  const { fetch } = github(bytes, { digest: `sha256:${"0".repeat(64)}` });
  await assert.rejects(
    ensureYouTubeCLI({
      installDir: dir,
      discover: noDiscovery,
      transport: { fetch },
    }),
    (e: unknown) =>
      e instanceof StudioError &&
      e.kind === "EXTERNAL_TOOL" &&
      /checksum/.test(e.message),
  );
  assert.deepEqual(await readdir(dir), []);
});

test("download failures are retryable and leave the cache empty", async () => {
  const dir = await installDir();
  const { bytes } = await releaseArchive();
  const { fetch } = github(bytes, { downloadStatus: 404 });
  await assert.rejects(
    ensureYouTubeCLI({
      installDir: dir,
      discover: noDiscovery,
      transport: { fetch },
    }),
    (e: unknown) => e instanceof StudioError && e.kind === "EXTERNAL_TOOL",
  );
  assert.deepEqual(await readdir(dir), []);
});

test("concurrent ensureYouTubeCLI calls share a single install", async () => {
  const dir = await installDir();
  const { bytes } = await releaseArchive();
  const { fetch, calls } = github(bytes);
  const [a, b] = await Promise.all([
    ensureYouTubeCLI({
      installDir: dir,
      discover: noDiscovery,
      transport: { fetch },
    }),
    ensureYouTubeCLI({
      installDir: dir,
      discover: noDiscovery,
      transport: { fetch },
    }),
  ]);
  assert.equal(a, b);
  assert.equal(calls.filter((c) => c.endsWith(ASSET_NAME)).length, 1);
  assert.deepEqual(await readdir(dir), ["youtubeuploader"]);
});

test("youTubeCLI still reports missing setups without downloading anything", async () => {
  const previous = process.env.WTS_YOUTUBEUPLOADER_PATH;
  process.env.WTS_YOUTUBEUPLOADER_PATH = path.join(
    await installDir(),
    "does-not-exist",
  );
  try {
    // The env override is authoritative for discovery, so PATH and the real
    // machine setup cannot leak into this assertion.
    assert.equal(await findYouTubeCLI(), null);
    await assert.rejects(
      youTubeCLI(),
      (e: unknown) =>
        e instanceof StudioError && e.kind === "MISSING_DEPENDENCY",
    );
  } finally {
    if (previous === undefined) delete process.env.WTS_YOUTUBEUPLOADER_PATH;
    else process.env.WTS_YOUTUBEUPLOADER_PATH = previous;
  }
});
