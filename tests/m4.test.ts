import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Studio } from "../packages/orchestrator/src/studio.ts";
import { Store } from "../packages/orchestrator/src/store.ts";
import {
  MockAIProvider,
  NarrativeAgent,
  PrevisualizationAgent,
  ResearchAgent,
  ScriptAgent,
  mockNarrative,
  mockPrevisualization,
  mockResearch,
  mockScript,
  parseScriptDocument,
  renderTeleprompter,
  type AIProvider,
  type ProviderResult,
  type ResearchInput,
  type StructuredRequest,
} from "../packages/agents/src/index.ts";

async function temporary<T>(fn: (root: string, store: Store) => Promise<T>) {
  const root = await mkdtemp(path.join(os.tmpdir(), "wts-m4-"));
  const store = new Store(root);
  try {
    return await fn(root, store);
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
}

/** Inline provider that replays a crafted output through the real schema. */
function stubProvider(output: () => unknown): AIProvider {
  return {
    name: "stub",
    async generateStructured<T>(
      request: StructuredRequest<T>,
    ): Promise<ProviderResult<T>> {
      return {
        output: request.schema.parse(output()),
        usage: {
          agent: request.name,
          provider: "stub",
          model: "stub-v1",
          inputTokens: 0,
          outputTokens: 0,
          audioSeconds: 0,
          imageCount: 0,
          costUSD: 0,
          elapsedMs: 0,
          createdAt: new Date().toISOString(),
        },
      };
    },
  };
}

const researchInput = (p: {
  id: string;
  description: string;
  creator: ReturnType<Store["create"]>["creator"];
  targetDuration: number;
}): ResearchInput => ({
  projectId: p.id,
  idea: p.description,
  creator: p.creator,
  targetDuration: p.targetDuration,
});

test("pre-production agents walk an idea to a teleprompter-ready script", async () =>
  temporary(async (root, store) => {
    const created = store.create(
      "Failover video",
      "Why multi-region failover still goes down at 3 AM",
      900,
    );
    const studio = new Studio(store);

    let snap = await studio.research(created.id);
    assert.equal(snap.status, "RESEARCHING");
    assert.ok(snap.research.notes.length > 10);
    assert.ok(snap.research.sources.length >= 2);
    assert.ok(snap.research.sources.every((s) => s.retrievedAt));
    assert.ok(
      existsSync(
        path.join(
          root,
          "projects",
          created.slug,
          "research",
          "research-v1.json",
        ),
      ),
    );

    snap = await studio.narrative(created.id);
    assert.equal(snap.status, "SCRIPTING");
    assert.ok(snap.outline.length >= 3);

    snap = await studio.draftScript(created.id);
    assert.equal(snap.status, "AWAITING_SCRIPT_APPROVAL");
    assert.equal(snap.scriptApproval, null);
    const draft = snap.scripts.at(-1)!.text;
    assert.match(draft, /^# /);
    assert.match(draft, /\*\*Core thesis:\*\*/);
    assert.match(draft, /## 0:00–\d/);
    assert.match(draft, /\*\*A-ROLL\*\*/);
    assert.match(draft, /^> /m);
    assert.match(draft, /\*\*B-ROLL\*\*/);
    assert.match(draft, /## CTA — /);
    assert.match(draft, /## Thumbnail/);
    assert.ok(
      existsSync(
        path.join(
          root,
          "projects",
          created.slug,
          "scripts",
          "script-doc-v1.json",
        ),
      ),
    );

    const pv = await studio.previsualize(created.id);
    assert.equal(pv.previsualization.scriptVersion, 1);
    const shots = pv.previsualization.shots;
    assert.ok(shots.length >= 3);
    assert.ok(shots.every((s) => s.endSeconds > s.startSeconds));
    for (let i = 1; i < shots.length; i++)
      assert.ok(shots[i].startSeconds >= shots[i - 1].startSeconds);
    assert.ok(shots.some((s) => s.setup === "on-camera"));
    assert.match(pv.runSheet, /^\d{2}:\d{2} — /m);
    assert.match(pv.runSheet, /Suggested recording order/);

    await assert.rejects(
      studio.teleprompter(created.id),
      /Approve the current script/,
    );
    const approved = await studio.approveScript(created.id, 1);
    assert.equal(approved.status, "READY_TO_RECORD");
    const tp = await studio.teleprompter(created.id);
    assert.equal(tp.scriptVersion, 1);
    assert.ok(tp.runSheet);
    assert.match(tp.text, /# Teleprompter — Failover video \(script v1\)/);
    assert.match(tp.text, /## Recording run sheet/);
    assert.match(tp.text, /\[B-ROLL:/);
    assert.ok(
      existsSync(
        path.join(
          root,
          "projects",
          created.slug,
          "scripts",
          "teleprompter-v1.md",
        ),
      ),
    );

    const agents = approved.usage.map((u) => u.agent);
    for (const expected of [
      "research_notes",
      "narrative_outline",
      "video_script",
      "previsualization",
    ])
      assert.ok(agents.includes(expected), `missing usage for ${expected}`);
    assert.ok(approved.usage.every((u) => u.costUSD === 0));
  }));

test("the example shooting script parses into structured sections and blocks", () => {
  // Self-contained fixture in the checked-in example format: timed sections,
  // A-ROLL/B-ROLL/ON SCREEN/SCREEN RECORDING blocks, spoken blockquotes.
  const text = `# Example video

## **The example shoot**

**Target:** 14–17 minutes
**Format:** primarily talking head + screen recordings/B-roll
**Core thesis:** AI reduced the cost of producing software, not of owning it.

---

## 0:00–0:50 — Cold open

**A-ROLL**

> I think we're about to have a production-readiness crisis.
>
> **If the application works, the application is ready.**
>
> It's not.
>
> The hard part begins after it works.

**B-ROLL**

- prompt → generated code
- terminal errors / monitoring dashboard / incident alert

Cut back to you on the final question.

---

## 0:50–2:20 — The illusion AI has created

**A-ROLL**

> I've been building software for a long time.
>
> Friction forced understanding.

**ON SCREEN**

> **Generation speed > comprehension speed**

Pause on this.

---

## 2:20–3:30 — Owning it

**A-ROLL**

> Nobody actually understands the system.

**SCREEN RECORDING**

Walk the deploy: push, pipeline, pages going green, then the 3 AM alert.

---

## 3:30–4:10 — Availability is a behavior

**A-ROLL**

> Availability is a behavior. Build it, then prove it.

**B-ROLL / SCREEN**

Monitoring dashboard over the recovery test.
`;
  const parsed = parseScriptDocument(text);
  assert.ok(parsed.sections.length >= 4);
  const cold = parsed.sections.find((s) => s.heading.includes("Cold open"))!;
  assert.equal(cold.startSeconds, 0);
  assert.equal(cold.endSeconds, 50);
  assert.ok(cold.blocks.some((b) => b.kind === "aroll"));
  assert.ok(cold.blocks.some((b) => b.kind === "broll"));
  const kinds = new Set(
    parsed.sections.flatMap((s) => s.blocks.map((b) => b.kind)),
  );
  assert.ok(kinds.has("onscreen"));
  assert.ok(kinds.has("screen"));

  const tp = renderTeleprompter({
    projectTitle: "Example",
    scriptVersion: 1,
    scriptText: text,
    runSheet: null,
  });
  assert.match(
    tp,
    /I think we're about to have a production-readiness crisis\./,
  );
  assert.match(tp, /\[B-ROLL:/);
  assert.match(tp, /\[SCREEN RECORDING:/);
  assert.ok(!tp.includes("**If the application works"));
});

test("pre-production gates stay enforced", async () =>
  temporary(async (_, store) => {
    const p = store.create(
      "Gated",
      "A concrete idea about database backups and recovery testing",
      600,
    );
    const studio = new Studio(store);
    await assert.rejects(
      studio.narrative(p.id),
      /Run research before the narrative pass/,
    );
    await assert.rejects(
      studio.draftScript(p.id),
      /Run research before the narrative pass/,
    );
    await studio.research(p.id);
    await studio.narrative(p.id);
    await studio.draftScript(p.id);
    await assert.rejects(
      studio.research(p.id),
      /Research runs before narrative and scripting/,
    );
    store.update(p.id, (x) => {
      x.status = "MEDIA_IMPORTED";
    });
    await assert.rejects(studio.draftScript(p.id), /has not locked its script/);
    await assert.rejects(studio.narrative(p.id), /has not locked its script/);
  }));

test("pre-visualization binds to the current script version and feeds the run sheet", async () =>
  temporary(async (_, store) => {
    const p = store.create(
      "Binding",
      "An idea about idempotent retries in payment APIs",
      600,
    );
    const studio = new Studio(store);
    await studio.research(p.id);
    await studio.narrative(p.id);
    await studio.draftScript(p.id);
    await studio.previsualize(p.id);
    await studio.approveScript(p.id, 1);
    let tp = await studio.teleprompter(p.id);
    assert.ok(tp.runSheet);

    await studio.saveScript(
      p.id,
      "# Edited\n\n## 0:00–0:40 — Cold open\n\n**A-ROLL**\n\n> New words on the record.\n",
    );
    await studio.approveScript(p.id, 2);
    tp = await studio.teleprompter(p.id);
    assert.equal(tp.runSheet, null);
    assert.match(tp.text, /New words on the record\./);

    const pv = await studio.previsualize(p.id);
    assert.equal(pv.previsualization.scriptVersion, 2);
    tp = await studio.teleprompter(p.id);
    assert.ok(tp.runSheet);
  }));

test("agents reject outputs that break their contracts", async () =>
  temporary(async (_, store) => {
    const p = store.create(
      "Validation",
      "An idea about queuing theory for API backpressure",
      600,
    );
    const input = researchInput(p);

    const ok = await new ResearchAgent(new MockAIProvider()).research(input);
    assert.equal(ok.usage.provider, "mock");

    const unlisted = structuredClone(mockResearch(input));
    unlisted.keyPoints[0].sourceUrls = ["https://example.org/not-listed"];
    await assert.rejects(
      new ResearchAgent(stubProvider(() => unlisted)).research(input),
      /does not list/,
    );

    const narrativeInput = {
      projectId: p.id,
      idea: p.description,
      research: mockResearch(input),
      creator: p.creator,
      targetDuration: 600,
    };
    const inflated = structuredClone(mockNarrative(narrativeInput));
    for (const s of inflated.sections) s.estimatedSeconds = 800;
    await assert.rejects(
      new NarrativeAgent(stubProvider(() => inflated)).narrate(narrativeInput),
      /budgets/,
    );

    const scriptInput = {
      projectId: p.id,
      idea: p.description,
      projectTitle: p.title,
      research: mockResearch(input),
      narrative: mockNarrative(narrativeInput),
      creator: p.creator,
      targetDuration: 600,
      scriptVersion: 1,
    };
    const overlapping = structuredClone(mockScript(scriptInput));
    overlapping.sections[1].timecode.startSeconds = 0;
    await assert.rejects(
      new ScriptAgent(stubProvider(() => overlapping)).draft(scriptInput),
      /overlaps the previous section/,
    );

    const pvInput = {
      projectId: p.id,
      script: {
        version: 2,
        text: "# S\n\n## 0:00–0:40 — Cold open\n\n**A-ROLL**\n\n> Words.\n",
      },
      creator: p.creator,
    };
    // Mock bound to v1, submitted while the current script is v2 → rejected.
    const stale = mockPrevisualization({
      ...pvInput,
      script: { ...pvInput.script, version: 1 },
    });
    await assert.rejects(
      new PrevisualizationAgent(stubProvider(() => stale)).previsualize(
        pvInput,
      ),
      /targets script v1/,
    );
  }));
