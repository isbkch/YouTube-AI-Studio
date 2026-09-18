import { createServer } from "node:http";
import { randomBytes, createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { hash, id, StudioError } from "../../../shared/src/index.ts";

export interface Vault {
  read(account: string): Promise<unknown>;
  write(account: string, value: unknown): Promise<void>;
  delete(account: string): Promise<void>;
}
export class KeychainVault implements Vault {
  constructor(private namespace: string) {}
  private async call(
    operation: string,
    account: string,
    value?: unknown,
  ): Promise<unknown> {
    if (process.platform !== "darwin")
      throw new StudioError(
        "UNSUPPORTED",
        "Analytics OAuth credentials require macOS Keychain. CSV import works without it.",
      );
    return new Promise((resolve, reject) => {
      const child = spawn(
        "/usr/bin/swift",
        [
          fileURLToPath(
            new URL(
              "../../../../scripts/analytics-keychain.swift",
              import.meta.url,
            ),
          ),
        ],
        { stdio: ["pipe", "pipe", "ignore"] },
      );
      let output = "";
      const timer = setTimeout(() => child.kill(), 30000);
      child.stdout.on("data", (data: Buffer) => {
        output += data.toString();
        if (output.length > 100000) child.kill();
      });
      child.on("error", () => {
        clearTimeout(timer);
        reject(
          new StudioError(
            "CONFIGURATION",
            "Cannot access analytics Keychain helper.",
          ),
        );
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        if (code !== 0)
          return reject(
            new StudioError(
              "CONFIGURATION",
              "Analytics Keychain access failed.",
              "Unlock your login keychain and retry.",
            ),
          );
        try {
          resolve(JSON.parse(output));
        } catch {
          reject(
            new StudioError("CONFIGURATION", "Invalid Keychain response."),
          );
        }
      });
      child.stdin.on("error", () => {});
      child.stdin.end(
        JSON.stringify({
          operation,
          account: `${this.namespace}-${account}`,
          value,
        }),
      );
    });
  }
  read(account: string) {
    return this.call("read", account);
  }
  async write(account: string, value: unknown) {
    await this.call("write", account, value);
  }
  async delete(account: string) {
    await this.call("delete", account);
  }
}
const clientSchema = z.object({
  client_id: z.string().min(1).max(500),
  client_secret: z.string().max(500).optional(),
});
type Client = z.infer<typeof clientSchema>;
const tokenSchema = z.object({
  access_token: z.string().min(1),
  refresh_token: z.string().optional(),
  expires_in: z.number().positive().default(3600),
  scope: z.string().optional(),
});
type Credentials = {
  client: Client;
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
};
const scopes = [
  "https://www.googleapis.com/auth/youtube.readonly",
  "https://www.googleapis.com/auth/yt-analytics.readonly",
];
type Candidate = {
  sessionId: string;
  channels: { id: string; title: string }[];
};
export class AnalyticsOAuth {
  private pending = new Map<
    string,
    {
      promise: Promise<{
        credentials: Credentials;
        channels: Candidate["channels"];
      }>;
      cancel: () => void;
      candidate?: { credentials: Credentials; channels: Candidate["channels"] };
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  constructor(
    readonly vault: Vault,
    private fetcher: typeof fetch = fetch,
  ) {}
  async configure(file: string) {
    if ((await stat(file)).size > 50000)
      throw new StudioError("INVALID_INPUT", "OAuth client file is too large.");
    let raw: unknown;
    try {
      raw = JSON.parse(await readFile(file, "utf8"));
    } catch {
      throw new StudioError(
        "INVALID_INPUT",
        "Choose a Google Desktop OAuth client JSON file.",
      );
    }
    const config = z.object({ installed: clientSchema }).safeParse(raw);
    if (!config.success)
      throw new StudioError(
        "INVALID_INPUT",
        "Choose a Google Desktop OAuth client JSON file with an installed client configuration.",
      );
    await this.vault.write("client", config.data.installed);
    return { clientId: config.data.installed.client_id };
  }
  async configured() {
    const c = await this.vault.read("client");
    return {
      configured: !!c,
      clientId: c ? clientSchema.parse(c).client_id : null,
    };
  }
  private async token(
    client: Client,
    fields: Record<string, string>,
    signal?: AbortSignal,
  ) {
    const response = await this.fetcher("https://oauth2.googleapis.com/token", {
      method: "POST",
      body: new URLSearchParams({
        ...fields,
        client_id: client.client_id,
        ...(client.client_secret
          ? { client_secret: client.client_secret }
          : {}),
      }),
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(30000)])
        : AbortSignal.timeout(30000),
    });
    if (!response.ok) {
      if (response.status === 429 || response.status >= 500)
        throw new StudioError(
          "EXTERNAL_TOOL",
          "YouTube authorization service is temporarily unavailable.",
          "Retry later; your connection and cached evidence are preserved.",
          true,
        );
      throw new StudioError(
        "CONFIGURATION",
        "YouTube authorization expired or was declined.",
        "Reconnect the channel.",
      );
    }
    return tokenSchema.parse(await response.json());
  }
  async begin() {
    if (this.pending.size)
      throw new StudioError(
        "CONFLICT",
        "A YouTube sign-in is already open.",
        "Finish or cancel it first.",
      );
    const saved = clientSchema.safeParse(await this.vault.read("client"));
    if (!saved.success)
      throw new StudioError(
        "CONFIGURATION",
        "Configure a Google Desktop OAuth client JSON file before connecting YouTube.",
      );
    const client = saved.data;
    const verifier = randomBytes(48).toString("base64url"),
      state = randomBytes(32).toString("base64url");
    const sessionId = id("oauth"),
      abort = new AbortController();
    let settle: (code: string) => void = () => {},
      fail: (error: Error) => void = () => {};
    const codePromise = new Promise<string>((resolve, reject) => {
      settle = resolve;
      fail = reject;
    });
    const server = createServer((request, response) => {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      if (url.pathname !== "/oauth/callback") {
        response.writeHead(404).end();
        return;
      }
      if (url.searchParams.get("state") !== state) {
        response.writeHead(400).end("Invalid sign-in state.");
        return;
      }
      const code = url.searchParams.get("code");
      response.setHeader("Content-Type", "text/plain; charset=utf-8");
      response.setHeader("Cache-Control", "no-store");
      if (!code) {
        response
          .writeHead(400)
          .end("Sign-in declined. Return to YouTube AI Studio.");
        fail(new StudioError("CONFIGURATION", "YouTube sign-in was declined."));
      } else {
        response.end(
          "Sign-in received. Return to YouTube AI Studio to confirm the channel.",
        );
        settle(code);
      }
      server.close();
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("No OAuth callback port");
    const redirect = `http://127.0.0.1:${address.port}/oauth/callback`;
    const promise = codePromise.then(async (code) => {
      const token = await this.token(
        client,
        {
          code,
          code_verifier: verifier,
          redirect_uri: redirect,
          grant_type: "authorization_code",
        },
        abort.signal,
      );
      if (!token.refresh_token)
        throw new StudioError(
          "CONFIGURATION",
          "Google did not return offline access.",
          "Reconnect and grant read-only analytics access.",
        );
      if (
        token.scope &&
        !scopes.every((s) => token.scope!.split(" ").includes(s))
      )
        throw new StudioError(
          "CONFIGURATION",
          "YouTube read-only and analytics permissions are both required.",
        );
      const response = await this.fetcher(
        "https://www.googleapis.com/youtube/v3/channels?part=snippet&mine=true",
        {
          headers: { Authorization: `Bearer ${token.access_token}` },
          signal: AbortSignal.any([abort.signal, AbortSignal.timeout(30000)]),
        },
      );
      if (!response.ok)
        throw new StudioError(
          "CONFIGURATION",
          "Unable to verify the YouTube channel.",
        );
      const data = z
        .object({
          items: z.array(
            z.object({
              id: z.string(),
              snippet: z.object({ title: z.string() }),
            }),
          ),
        })
        .parse(await response.json());
      if (!data.items.length)
        throw new StudioError(
          "CONFIGURATION",
          "This account has no accessible YouTube channel.",
        );
      return {
        credentials: {
          client,
          accessToken: token.access_token,
          refreshToken: token.refresh_token,
          expiresAt: Date.now() + token.expires_in * 1000,
        },
        channels: data.items.map((c) => ({ id: c.id, title: c.snippet.title })),
      };
    });
    void promise.catch(() => {});
    const cancel = () => {
      abort.abort();
      server.close();
      fail(new StudioError("CANCELLED", "YouTube sign-in cancelled."));
    };
    const timer = setTimeout(() => {
      cancel();
      this.pending.delete(sessionId);
    }, 600000);
    timer.unref();
    this.pending.set(sessionId, { promise, cancel, timer });
    const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
    url.search = new URLSearchParams({
      client_id: client.client_id,
      redirect_uri: redirect,
      response_type: "code",
      scope: scopes.join(" "),
      state,
      code_challenge: createHash("sha256").update(verifier).digest("base64url"),
      code_challenge_method: "S256",
      access_type: "offline",
      prompt: "consent",
    }).toString();
    return { sessionId, url: url.toString() };
  }
  cancel(sessionId: string) {
    const p = this.pending.get(sessionId);
    if (p) {
      clearTimeout(p.timer);
      p.cancel();
      this.pending.delete(sessionId);
    }
    return { cancelled: true };
  }
  async finish(sessionId: string, signal?: AbortSignal): Promise<Candidate> {
    const p = this.pending.get(sessionId);
    if (!p)
      throw new StudioError("CONFLICT", "Sign-in expired; connect again.");
    const onAbort = () => this.cancel(sessionId);
    signal?.addEventListener("abort", onAbort, { once: true });
    try {
      signal?.throwIfAborted();
      p.candidate = await p.promise;
      signal?.throwIfAborted();
      if (!this.pending.has(sessionId))
        throw new StudioError("CANCELLED", "YouTube sign-in cancelled.");
      return { sessionId, channels: p.candidate.channels };
    } catch (e) {
      this.cancel(sessionId);
      throw e;
    } finally {
      signal?.removeEventListener("abort", onAbort);
    }
  }
  async confirm(sessionId: string, channelId: string) {
    const p = this.pending.get(sessionId),
      candidate = p?.candidate,
      channel = candidate?.channels.find((c) => c.id === channelId);
    if (!candidate || !channel)
      throw new StudioError(
        "INVALID_INPUT",
        "Confirm a channel returned by this sign-in.",
      );
    await this.vault.write(`channel-${channelId}`, candidate.credentials);
    this.cancel(sessionId);
    return channel;
  }
  async access(channelId: string, signal?: AbortSignal) {
    const raw = await this.vault.read(`channel-${channelId}`);
    const c = z
      .object({
        client: clientSchema,
        accessToken: z.string(),
        refreshToken: z.string(),
        expiresAt: z.number(),
      })
      .safeParse(raw);
    if (!c.success)
      throw new StudioError("CONFIGURATION", "Connect YouTube before syncing.");
    if (c.data.expiresAt > Date.now() + 60000) return c.data.accessToken;
    const token = await this.token(
      c.data.client,
      { refresh_token: c.data.refreshToken, grant_type: "refresh_token" },
      signal,
    );
    const next = {
      ...c.data,
      accessToken: token.access_token,
      refreshToken: token.refresh_token ?? c.data.refreshToken,
      expiresAt: Date.now() + token.expires_in * 1000,
    };
    await this.vault.write(`channel-${channelId}`, next);
    return next.accessToken;
  }
  async disconnect(channelId: string) {
    await this.vault.delete(`channel-${channelId}`);
  }
}
export const libraryVault = (root: string) =>
  new KeychainVault(hash(root).slice(0, 24));
