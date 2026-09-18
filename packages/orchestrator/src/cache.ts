import { readFile, rename, rm, stat } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import {
  atomicJSON,
  fileHash,
  id,
  now,
  safePath,
  StudioError,
} from "../../shared/src/index.ts";
import type { Asset } from "./model.ts";
import type { Store } from "./store.ts";

/**
 * Derived-output cache discipline shared by builds, storyboard previews and
 * the built-in SFX bank: unique partial files promoted on success, hash
 * manifests verified on reuse.
 */
export interface Cached {
  path: string;
  outputHash: string;
  renderMs: number;
}
export async function cachedFile(
  dir: string,
  key: string,
  relative: string,
  render: (temp: string) => Promise<void>,
): Promise<Cached & { reused: boolean }> {
  const output = await safePath(dir, relative);
  const manifest = await safePath(dir, `cache/${key}.json`);
  try {
    const c = JSON.parse(await readFile(manifest, "utf8")) as Cached;
    if (
      c.path === relative &&
      (await stat(output)).size > 0 &&
      (await fileHash(output)) === c.outputHash
    )
      return { ...c, reused: true };
  } catch (e) {
    if (e instanceof StudioError) throw e;
  }
  const temp =
    output.replace(/\.(mp4|mp3|webm)$/, "") +
    `.${id("partial")}.` +
    output.split(".").at(-1);
  const started = performance.now();
  try {
    await render(temp);
    const outputHash = await fileHash(temp);
    await rename(temp, output);
    const c = {
      path: relative,
      outputHash,
      renderMs: performance.now() - started,
    };
    await atomicJSON(manifest, c);
    return { ...c, reused: false };
  } finally {
    await rm(temp, { force: true });
  }
}

/**
 * Persist a derived-output asset row. Shared by builds and storyboard
 * previews so both record provenance the same way; callers add their own
 * job linkage (builds attach `producedAssets`, previews use the synthetic id).
 */
export function recordAsset(
  store: Store,
  projectId: string,
  planVersion: number,
  jobId: string,
  type: Asset["type"],
  key: string,
  c: Cached & { reused: boolean },
  sceneId: string | null,
  extra: Partial<Asset> = {},
): Asset {
  const a: Asset = {
    assetId: id("asset"),
    type,
    sceneId,
    productionPlanVersion: planVersion,
    generator:
      type === "remotion-render" || type === "caption-render"
        ? "remotion"
        : "ffmpeg",
    template: null,
    templateVersion: null,
    parameters: {},
    inputHash: key,
    outputHash: c.outputHash,
    createdAt: now(),
    path: c.path,
    jobId,
    reused: c.reused,
    sourceAssets: [],
    renderMs: c.reused ? 0 : c.renderMs,
    ...extra,
  };
  store.asset(projectId, a);
  return a;
}
