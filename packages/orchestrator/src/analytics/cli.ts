import { createInterface } from "node:readline/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile, stat } from "node:fs/promises";
import { z } from "zod";
import { StudioError } from "../../../shared/src/index.ts";
import type { AnalyticsService } from "./service.ts";

export async function channelCLI(
  service: AnalyticsService,
  args: string[],
  flags: { file?: string; channel?: string; yes?: boolean; complete?: boolean },
  signal: AbortSignal,
) {
  let payload: Record<string, unknown> = {};
  if (flags.file) {
    if ((await stat(flags.file)).size > 2_000_000)
      throw new StudioError("INVALID_INPUT", "Input JSON exceeds 2 MB.");
    payload = z
      .record(z.string(), z.unknown())
      .parse(JSON.parse(await readFile(flags.file, "utf8")));
  }
  const [group, action] = args;
  if (group === "analytics" && action === "connect") {
    if (args[2]) await service.oauth.configure(args[2]);
    const session = await service.oauth.begin();
    try {
      process.stderr.write(`Open Google sign-in: ${session.url}\n`);
      if (process.platform === "darwin")
        await promisify(execFile)("/usr/bin/open", [session.url]);
      const candidate = await service.oauth.finish(session.sessionId, signal);
      const input = createInterface({
        input: process.stdin,
        output: process.stderr,
      });
      let answer: string;
      try {
        answer = await input.question(
          `Confirm channel ID (${candidate.channels.map((c) => `${c.title}: ${c.id}`).join(", ")}): `,
          { signal },
        );
      } finally {
        input.close();
      }
      return await service.confirmConnection(
        session.sessionId,
        answer.trim(),
        signal,
      );
    } finally {
      service.oauth.cancel(session.sessionId);
    }
  }
  if (group === "analytics" && action === "sample") return service.sample();
  if (group === "analytics" && action === "call")
    return service.dispatch(args[2], payload, signal);
  const channelId = flags.channel ?? service.snapshot().channel?.id;
  if (
    action === "status" ||
    action === "list" ||
    (!action && group === "analytics")
  )
    return service.dispatch(
      "analytics.snapshot",
      channelId ? { channelId } : {},
      signal,
    );
  if (group === "analytics" && action === "import") {
    if (!args[2])
      throw new StudioError(
        "INVALID_INPUT",
        "Provide the Studio CSV path: analytics import <report.csv> --file <options.json>.",
      );
    const preview = await service.previewImport(args[2], payload);
    process.stderr.write(JSON.stringify(preview, null, 2) + "\n");
    if (!flags.yes) return preview;
    return service.commitImport(preview.token, true, flags.complete === true);
  }
  if (!channelId)
    throw new StudioError(
      "INVALID_INPUT",
      "Connect a channel or import a Studio report first.",
    );
  const methods: Record<string, string> = {
    "analytics sync": "analytics.sync",
    "analytics older": "analytics.sync",
    "analytics disconnect": "analytics.connection.disconnect",
    "analytics delete": "analytics.data.delete",
    "strategy save": "channel.strategy.save",
    "outcomes save": "outcomes.save",
    "reviews save": "reviews.save",
    "reviews followUp": "reviews.followUp",
    "topics generate": "topics.generate",
    "topics decide": "topics.decide",
    "topics update": "topics.update",
    "topics createProject": "topics.createProject",
  };
  const method = methods[`${group} ${action}`];
  if (!method)
    throw new StudioError(
      "INVALID_INPUT",
      "Unknown channel command. Run wts --help.",
    );
  if (group === "strategy") payload = { strategy: payload };
  if (group === "outcomes") payload = { outcome: payload };
  if (group === "reviews" && action === "save") payload = { review: payload };
  return service.dispatch(
    method,
    {
      ...payload,
      channelId,
      older: action === "older",
      confirm: flags.yes === true,
    },
    signal,
  );
}
