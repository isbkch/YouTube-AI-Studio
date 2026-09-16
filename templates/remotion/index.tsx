import React from "react";
import {
  AbsoluteFill,
  Composition,
  interpolate,
  registerRoot,
  useCurrentFrame,
  useVideoConfig,
} from "remotion";

/**
 * WinTheCloud Remotion primitives. One composition ("WinTheCloudVisual");
 * the template name selects the primitive. Designs are laid out in a
 * 1280×720 design space and scaled to the composition size, so text stays
 * crisp at 1080p and above.
 */

export type TerminalLine = { kind: "input" | "output" | "error"; text: string };
export type VisualParameters =
  | { title: string; subtitle: string } // ChapterTitle, Callout
  | { quote: string; attribution: string }
  | {
      title: string;
      subtitle: string;
      nodes: string[];
      emphasis: number;
    }
  | {
      title: string;
      subtitle: string;
      layers: { name: string; components: string[] }[];
      failedLayer: number;
    }
  | {
      title: string;
      subtitle: string;
      method: string;
      path: string;
      steps: string[];
      failureStep: number;
    }
  | { title: string; fileName: string; lines: string[]; highlight: number }
  | { title: string; lines: TerminalLine[] }
  | {
      title: string;
      fileName: string;
      removed: string[];
      added: string[];
    }
  | {
      title: string;
      subtitle: string;
      unit: string;
      series: number[];
      threshold: number | null;
      goodDirection: "up" | "down";
    }
  | {
      title: string;
      subtitle: string;
      nodes: string[];
      failedNode: number;
      recovered: boolean;
    };

export type VisualProps = {
  template: string;
  parameters: VisualParameters;
  brand: {
    background: string;
    foreground: string;
    accent: string;
    fontFamily: string;
  };
  durationFrames: number;
  width: number;
  height: number;
  fps: number;
};

const danger = "#ef9988";
const dangerBg = "#35272b";
const panelBg = "#172637";
const mono = "SF Mono, Menlo, Monaco, Consolas, monospace";

const defaults: VisualProps = {
  template: "Callout",
  parameters: { title: "Redundancy is not high availability.", subtitle: "" },
  brand: {
    background: "#101b29",
    foreground: "#f2f4ed",
    accent: "#c8ef80",
    fontFamily: "Helvetica Neue",
  },
  durationFrames: 180,
  width: 1280,
  height: 720,
  fps: 30,
};

const label: React.CSSProperties = {
  fontSize: 16,
  fontWeight: 600,
  letterSpacing: 3,
  textTransform: "uppercase",
};

interface PrimitiveProps {
  p: VisualParameters;
  b: VisualProps["brand"];
  f: number;
  fps: number;
  durationFrames: number;
  enter: number;
}

const fade = (enter: number, dy = 16): React.CSSProperties => ({
  opacity: enter,
  transform: `translateY(${(1 - enter) * dy}px)`,
});

/** Title + subtitle header used by most primitives. */
const Heading: React.FC<{
  title: string;
  enter: number;
  accent: string;
  small?: boolean;
}> = ({ title, enter, accent, small }) => (
  <>
    <div
      style={{
        width: 55,
        height: 4,
        background: accent,
        marginBottom: 26,
        ...fade(enter, 8),
      }}
    />
    <div
      style={{
        fontSize: small ? 44 : 52,
        lineHeight: 1.12,
        fontWeight: 600,
        letterSpacing: -1.6,
        maxWidth: 1150,
        overflowWrap: "anywhere",
        ...fade(enter),
      }}
    >
      {title}
    </div>
  </>
);

const ChapterTitlePrimitive: React.FC<PrimitiveProps> = ({ p, b, enter }) => {
  if (!("subtitle" in p)) return null;
  return (
    <div
      style={{
        position: "absolute",
        inset: "160px 80px 120px 64px",
        display: "flex",
        flexDirection: "column",
        justifyContent: "center",
        ...fade(enter, 20),
      }}
    >
      <Heading title={p.title} enter={enter} accent={b.accent} />
      <div
        style={{
          fontSize: 28,
          lineHeight: 1.4,
          marginTop: 28,
          opacity: 0.62,
          maxWidth: 1080,
        }}
      >
        {p.subtitle}
      </div>
    </div>
  );
};

const CalloutPrimitive: React.FC<PrimitiveProps> = ({ p, b, enter }) => {
  if (!("subtitle" in p)) return null;
  return (
    <div
      style={{
        position: "absolute",
        inset: 0,
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        padding: "0 130px",
        ...fade(enter),
      }}
    >
      <div
        style={{
          fontSize: p.title.length > 64 ? 56 : 68,
          lineHeight: 1.12,
          fontWeight: 560,
          letterSpacing: -2,
          textAlign: "center",
          maxWidth: 1020,
          overflowWrap: "anywhere",
        }}
      >
        {p.title}
      </div>
      <div
        style={{
          width: 110,
          height: 5,
          borderRadius: 3,
          background: b.accent,
          margin: "34px 0 26px",
          opacity: 0.8,
        }}
      />
      <div style={{ fontSize: 27, opacity: 0.62, textAlign: "center" }}>
        {p.subtitle}
      </div>
    </div>
  );
};

const QuotePrimitive: React.FC<PrimitiveProps> = ({ p, b, enter }) => {
  if (!("quote" in p)) return null;
  return (
    <div
      style={{
        position: "absolute",
        inset: "120px 110px 120px 150px",
        display: "flex",
        flexDirection: "column",
        justifyContent: "center",
        ...fade(enter),
      }}
    >
      <div
        style={{
          fontSize: 120,
          lineHeight: 0.6,
          color: b.accent,
          fontFamily: "Georgia, serif",
          marginBottom: 30,
          opacity: 0.9,
        }}
      >
        “
      </div>
      <div
        style={{
          fontSize: p.quote.length > 180 ? 34 : 42,
          lineHeight: 1.35,
          fontWeight: 500,
          fontFamily: "Georgia, serif",
          fontStyle: "italic",
          overflowWrap: "anywhere",
        }}
      >
        {p.quote}
      </div>
      <div
        style={{
          marginTop: 36,
          ...label,
          fontSize: 15,
          color: b.accent,
          opacity: 0.9,
        }}
      >
        — {p.attribution || "VERBATIM"}
      </div>
    </div>
  );
};

const FlowNode: React.FC<{
  children: React.ReactNode;
  accent: string;
  highlighted?: boolean;
  failed?: boolean;
  enter: number;
  small?: boolean;
}> = ({ children, accent, highlighted, failed, enter, small }) => (
  <div
    style={{
      flex: 1,
      minWidth: 0,
      height: small ? 110 : 142,
      border: `1.5px solid ${failed ? danger : highlighted ? accent : accent + "65"}`,
      background: failed ? dangerBg : panelBg,
      borderRadius: 14,
      padding: small ? "16px 14px" : "22px 16px",
      boxSizing: "border-box",
      ...fade(enter),
    }}
  >
    {children}
  </div>
);

const ArchitectureFlowPrimitive: React.FC<PrimitiveProps> = ({
  p,
  b,
  f,
  fps,
  enter,
}) => {
  if (!("nodes" in p) || !("emphasis" in p)) return null;
  return (
    <>
      <div
        style={{
          position: "absolute",
          left: 64,
          top: 118,
          right: 64,
          ...fade(enter),
        }}
      >
        <Heading
          title={p.title}
          enter={enter}
          accent={b.accent}
          small={p.title.length > 55}
        />
      </div>
      <div
        style={{
          position: "absolute",
          left: 64,
          right: 64,
          top: p.title.length > 55 ? 280 : 264,
          height: 162,
          display: "flex",
          alignItems: "center",
        }}
      >
        {p.nodes.map((node, i) => (
          <React.Fragment key={i}>
            {i > 0 && (
              <div
                style={{
                  flex: "0 0 44px",
                  height: 2,
                  background: `${b.accent}45`,
                  position: "relative",
                }}
              >
                <div
                  style={{
                    position: "absolute",
                    width: 7,
                    height: 7,
                    borderRadius: 5,
                    background: b.accent,
                    top: -3,
                    left: (((f / fps) * 0.45 + i * 0.17) % 1) * 37,
                  }}
                />
              </div>
            )}
            <FlowNode
              accent={b.accent}
              failed={i === p.emphasis}
              enter={Math.min(1, Math.max(0, enter * 1.4 - i * 0.12))}
            >
              <div
                style={{
                  ...label,
                  fontSize: 13,
                  color: i === p.emphasis ? danger : b.accent,
                  marginBottom: 20,
                }}
              >
                {i === p.emphasis ? "SHARED FAILURE" : `0${i + 1} / SERVICE`}
              </div>
              <div
                style={{
                  fontSize: p.nodes.length > 4 ? 22 : 26,
                  lineHeight: 1.12,
                  fontWeight: 500,
                  overflowWrap: "anywhere",
                }}
              >
                {node}
              </div>
            </FlowNode>
          </React.Fragment>
        ))}
      </div>
      <div
        style={{
          position: "absolute",
          left: 64,
          right: 64,
          top: 500,
          fontSize: 25,
          opacity: 0.62,
          lineHeight: 1.4,
          ...fade(enter),
        }}
      >
        {p.subtitle}
      </div>
    </>
  );
};

const ArchitectureDiagramPrimitive: React.FC<PrimitiveProps> = ({
  p,
  b,
  enter,
}) => {
  if (!("layers" in p)) return null;
  const rowHeight = 96;
  const top = 250;
  return (
    <>
      <div style={{ position: "absolute", left: 64, top: 110, right: 64 }}>
        <Heading title={p.title} enter={enter} accent={b.accent} small />
      </div>
      <div
        style={{
          position: "absolute",
          left: 64,
          right: 64,
          top,
          display: "flex",
          flexDirection: "column",
          gap: 14,
        }}
      >
        {p.layers.map((layer, i) => {
          const failed = i === p.failedLayer;
          return (
            <div
              key={i}
              style={{
                display: "flex",
                alignItems: "stretch",
                gap: 18,
                height: rowHeight,
                ...fade(Math.min(1, enter * 1.5 - i * 0.15)),
              }}
            >
              <div
                style={{
                  flex: "0 0 170px",
                  border: `1.5px solid ${failed ? danger : b.accent + "65"}`,
                  background: failed ? dangerBg : panelBg,
                  borderRadius: 12,
                  display: "flex",
                  alignItems: "center",
                  paddingLeft: 20,
                  ...label,
                  fontSize: 14,
                  color: failed ? danger : b.accent,
                }}
              >
                {failed ? "FAILS" : `TIER ${i + 1}`}
              </div>
              <div
                style={{
                  flex: "0 0 210px",
                  display: "flex",
                  alignItems: "center",
                  fontSize: 26,
                  fontWeight: 560,
                  overflowWrap: "anywhere",
                }}
              >
                {layer.name}
              </div>
              <div
                style={{
                  flex: 1,
                  display: "flex",
                  gap: 12,
                }}
              >
                {layer.components.map((component, j) => (
                  <div
                    key={j}
                    style={{
                      flex: 1,
                      border: `1.5px solid ${failed ? danger + "aa" : b.foreground + "30"}`,
                      borderRadius: 10,
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      fontSize: 22,
                      fontWeight: 500,
                      color: failed ? danger : b.foreground,
                      background: failed ? "#2a1d21" : "#14202f",
                      overflowWrap: "anywhere",
                      padding: 8,
                    }}
                  >
                    {component}
                  </div>
                ))}
              </div>
            </div>
          );
        })}
      </div>
      <div
        style={{
          position: "absolute",
          left: 64,
          right: 64,
          bottom: 92,
          fontSize: 25,
          opacity: 0.62,
          ...fade(enter),
        }}
      >
        {p.subtitle}
      </div>
    </>
  );
};

const RequestFlowPrimitive: React.FC<PrimitiveProps> = ({
  p,
  b,
  f,
  fps,
  durationFrames,
  enter,
}) => {
  if (!("steps" in p) || !("path" in p)) return null;
  const loop = (f / fps) % 3.2;
  const failAt = p.failureStep >= 0 ? 0.62 : 2;
  const failing = p.failureStep >= 0 && f / fps > failAt * 0.9;
  const progress = Math.min(0.999, loop / 3.2) * p.steps.length;
  const activeStep = Math.floor(progress);
  return (
    <>
      <div style={{ position: "absolute", left: 64, top: 108, right: 64 }}>
        <Heading title={p.title} enter={enter} accent={b.accent} small />
      </div>
      <div
        style={{
          position: "absolute",
          left: 64,
          top: 240,
          display: "flex",
          alignItems: "center",
          gap: 16,
          ...fade(enter),
        }}
      >
        <span
          style={{
            ...label,
            fontSize: 16,
            color: b.background,
            background: b.accent,
            padding: "8px 16px",
            borderRadius: 8,
          }}
        >
          {p.method}
        </span>
        <span style={{ fontFamily: mono, fontSize: 26, opacity: 0.85 }}>
          {p.path}
        </span>
      </div>
      <div
        style={{
          position: "absolute",
          left: 64,
          right: 64,
          top: 330,
          height: 150,
          display: "flex",
          alignItems: "center",
        }}
      >
        {p.steps.map((step, i) => (
          <React.Fragment key={i}>
            {i > 0 && (
              <div
                style={{
                  flex: "0 0 46px",
                  height: 2,
                  background:
                    failing && i === p.failureStep
                      ? `${danger}cc`
                      : `${b.accent}45`,
                  position: "relative",
                }}
              >
                <div
                  style={{
                    position: "absolute",
                    width: 9,
                    height: 9,
                    borderRadius: 6,
                    background:
                      failing && i <= p.failureStep ? danger : b.accent,
                    top: -4,
                    left: Math.min(1, Math.max(0, progress - i)) * 38,
                    opacity: activeStep >= i - 1 ? 1 : 0.25,
                  }}
                />
              </div>
            )}
            <FlowNode
              accent={b.accent}
              failed={failing && i === p.failureStep}
              highlighted={!failing && i === activeStep}
              enter={Math.min(1, enter * 1.4 - i * 0.1)}
              small
            >
              <div
                style={{
                  ...label,
                  fontSize: 12,
                  marginBottom: 14,
                  color:
                    failing && i === p.failureStep
                      ? danger
                      : i === activeStep && !failing
                        ? b.accent
                        : b.foreground,
                  opacity:
                    i === activeStep || (failing && i === p.failureStep)
                      ? 1
                      : 0.45,
                }}
              >
                {i === p.failureStep && failing
                  ? "503 — FAILS HERE"
                  : `STEP ${i + 1}`}
              </div>
              <div
                style={{
                  fontSize: 24,
                  fontWeight: 500,
                  overflowWrap: "anywhere",
                }}
              >
                {step}
              </div>
            </FlowNode>
          </React.Fragment>
        ))}
      </div>
      <div
        style={{
          position: "absolute",
          left: 64,
          right: 64,
          bottom: 96,
          fontSize: 25,
          opacity: 0.62,
          ...fade(enter),
        }}
      >
        {p.subtitle}
      </div>
      <div
        style={{
          position: "absolute",
          right: 70,
          top: 250,
          ...label,
          fontSize: 13,
          opacity: 0.4,
        }}
      >
        {Math.round(durationFrames / fps)}s WINDOW
      </div>
    </>
  );
};

const CodeRevealPrimitive: React.FC<PrimitiveProps> = ({
  p,
  b,
  f,
  fps,
  enter,
}) => {
  if (!("lines" in p) || !("fileName" in p)) return null;
  const perLine = Math.max(4, Math.min(24, (fps * 2.2) / p.lines.length));
  return (
    <>
      <div style={{ position: "absolute", left: 64, top: 104, right: 64 }}>
        <Heading title={p.title} enter={enter} accent={b.accent} small />
        <div
          style={{
            marginTop: 14,
            fontFamily: mono,
            fontSize: 19,
            color: b.accent,
            opacity: 0.85,
          }}
        >
          {p.fileName}
        </div>
      </div>
      <div
        style={{
          position: "absolute",
          left: 64,
          right: 64,
          top: 258,
          bottom: 108,
          background: "#0d1622",
          border: `1.5px solid ${b.foreground}22`,
          borderRadius: 14,
          padding: "22px 26px",
          fontFamily: mono,
          fontSize: 24,
          lineHeight: 1.62,
          overflow: "hidden",
        }}
      >
        {p.lines.map((line, i) => {
          const shown = f - i * perLine;
          const visible = interpolate(shown, [0, 6], [0, 1], {
            extrapolateLeft: "clamp",
            extrapolateRight: "clamp",
          });
          return (
            <div
              key={i}
              style={{
                display: "flex",
                opacity: visible,
                transform: `translateX(${(1 - visible) * 14}px)`,
                background: i === p.highlight ? `${b.accent}22` : "transparent",
                borderRadius: 6,
                padding: "0 8px",
                marginLeft: -8,
                minHeight: 39,
              }}
            >
              <span
                style={{
                  opacity: 0.35,
                  width: 44,
                  flex: "0 0 44px",
                  fontSize: 18,
                  paddingTop: 3,
                }}
              >
                {String(i + 1).padStart(2, "0")}
              </span>
              <span
                style={{
                  color: i === p.highlight ? b.accent : b.foreground,
                  whiteSpace: "pre-wrap",
                  overflowWrap: "anywhere",
                }}
              >
                {line || " "}
              </span>
            </div>
          );
        })}
      </div>
    </>
  );
};

const TerminalPrimitive: React.FC<PrimitiveProps> = ({
  p,
  b,
  f,
  fps,
  enter,
}) => {
  if (!("lines" in p) || "fileName" in p) return null;
  const lines = p.lines;
  // Budget the typing window across input lines; outputs appear after theirs.
  const inputs = lines.filter((l) => l.kind === "input");
  const perInput = Math.max(8, (fps * 2.4) / Math.max(1, inputs.length));
  let elapsedInputs = 0;
  const rows: React.ReactNode[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.kind === "input") {
      const start = elapsedInputs;
      elapsedInputs += perInput;
      const typed = Math.floor(
        (Math.max(0, f - 6 - start) / Math.max(1, perInput - 6)) *
          line.text.length,
      );
      rows.push(
        <div key={i} style={{ display: "flex", minHeight: 40 }}>
          <span style={{ color: b.accent, marginRight: 12 }}>❯</span>
          <span style={{ whiteSpace: "pre-wrap" }}>
            {line.text.slice(0, typed)}
            {typed < line.text.length && f % 16 < 8 ? "▌" : ""}
          </span>
        </div>,
      );
    } else {
      const appears = elapsedInputs - perInput * 0.45;
      const visible = interpolate(f - appears, [0, 5], [0, 1], {
        extrapolateLeft: "clamp",
        extrapolateRight: "clamp",
      });
      rows.push(
        <div
          key={i}
          style={{
            color: line.kind === "error" ? danger : b.foreground,
            opacity: visible * (line.kind === "error" ? 1 : 0.85),
            whiteSpace: "pre-wrap",
            paddingLeft: 24,
            minHeight: 34,
            overflowWrap: "anywhere",
          }}
        >
          {line.text}
        </div>,
      );
    }
  }
  return (
    <>
      <div style={{ position: "absolute", left: 64, top: 108, right: 64 }}>
        <Heading title={p.title} enter={enter} accent={b.accent} small />
      </div>
      <div
        style={{
          position: "absolute",
          left: 64,
          right: 64,
          top: 250,
          bottom: 104,
          background: "#0a111b",
          border: `1.5px solid ${b.foreground}22`,
          borderRadius: 14,
          overflow: "hidden",
          ...fade(enter),
        }}
      >
        <div
          style={{
            height: 42,
            background: "#16222f",
            display: "flex",
            alignItems: "center",
            paddingLeft: 18,
            gap: 8,
          }}
        >
          {["#ef6a5a", "#e5c150", "#6ace7e"].map((c) => (
            <div
              key={c}
              style={{ width: 12, height: 12, borderRadius: 7, background: c }}
            />
          ))}
          <span style={{ marginLeft: 14, opacity: 0.45, fontSize: 15 }}>
            zsh — deployment
          </span>
        </div>
        <div
          style={{
            padding: "20px 24px",
            fontFamily: mono,
            fontSize: 24,
            lineHeight: 1.65,
          }}
        >
          {rows}
        </div>
      </div>
    </>
  );
};

const CodeDiffPrimitive: React.FC<PrimitiveProps> = ({
  p,
  b,
  f,
  fps,
  enter,
}) => {
  if (!("removed" in p) || !("added" in p) || !("fileName" in p)) return null;
  const total = p.removed.length + p.added.length;
  const perLine = Math.max(4, Math.min(20, (fps * 2.4) / Math.max(1, total)));
  const column = (
    lines: string[],
    kind: "removed" | "added",
  ): React.ReactNode => (
    <div style={{ flex: 1, minWidth: 0 }}>
      <div
        style={{
          ...label,
          fontSize: 13,
          color: kind === "added" ? b.accent : danger,
          marginBottom: 12,
          opacity: 0.9,
        }}
      >
        {kind === "added" ? "AFTER" : "BEFORE"}
      </div>
      {lines.map((line, i) => {
        const at = (kind === "added" ? p.removed.length + i : i) * perLine;
        const visible = interpolate(f - at, [0, 6], [0, 1], {
          extrapolateLeft: "clamp",
          extrapolateRight: "clamp",
        });
        return (
          <div
            key={i}
            style={{
              fontFamily: mono,
              fontSize: 22,
              lineHeight: 1.5,
              padding: "6px 12px",
              marginBottom: 6,
              borderRadius: 8,
              opacity: visible,
              transform: `translateX(${(1 - visible) * (kind === "added" ? 18 : -18)}px)`,
              background: kind === "added" ? `${b.accent}14` : `${danger}12`,
              borderLeft: `3px solid ${kind === "added" ? b.accent : danger}`,
              whiteSpace: "pre-wrap",
              overflowWrap: "anywhere",
              minHeight: 36,
            }}
          >
            <span style={{ opacity: 0.55, marginRight: 10 }}>
              {kind === "added" ? "+" : "−"}
            </span>
            {line}
          </div>
        );
      })}
    </div>
  );
  return (
    <>
      <div style={{ position: "absolute", left: 64, top: 104, right: 64 }}>
        <Heading title={p.title} enter={enter} accent={b.accent} small />
        <div
          style={{
            marginTop: 14,
            fontFamily: mono,
            fontSize: 19,
            color: b.accent,
            opacity: 0.85,
          }}
        >
          {p.fileName}
        </div>
      </div>
      <div
        style={{
          position: "absolute",
          left: 64,
          right: 64,
          top: 262,
          bottom: 110,
          display: "flex",
          gap: 34,
        }}
      >
        {column(p.removed, "removed")}
        {column(p.added, "added")}
      </div>
    </>
  );
};

const MetricChartPrimitive: React.FC<PrimitiveProps> = ({
  p,
  b,
  f,
  durationFrames,
  enter,
}) => {
  if (!("series" in p) || !("unit" in p)) return null;
  const W = 1120,
    H = 330,
    left = 64,
    top = 268;
  const values = p.series;
  const lo = Math.min(...values, p.threshold ?? Infinity);
  const hi = Math.max(...values, p.threshold ?? -Infinity);
  const span = hi - lo || 1;
  const x = (i: number) => (i / Math.max(1, values.length - 1)) * W;
  const y = (v: number) => H - ((v - lo) / span) * H;
  const reveal = interpolate(
    f,
    [Math.min(18, durationFrames * 0.18), durationFrames * 0.8],
    [0, 1],
    { extrapolateLeft: "clamp", extrapolateRight: "clamp" },
  );
  const points = values.map((v, i) => `${x(i)},${y(v)}`).join(" ");
  const last = Math.max(1, Math.floor(reveal * values.length));
  const shown = values.slice(0, last);
  const current = shown.at(-1) ?? values[0];
  const good =
    p.goodDirection === "up"
      ? current >= lo + span * 0.6
      : current <= lo + span * 0.4;
  const color = good ? b.accent : danger;
  return (
    <>
      <div style={{ position: "absolute", left: 64, top: 108, right: 64 }}>
        <Heading title={p.title} enter={enter} accent={b.accent} small />
      </div>
      <div
        style={{
          position: "absolute",
          left,
          top,
          width: W,
          height: H,
          ...fade(enter),
        }}
      >
        {[0.25, 0.5, 0.75].map((g) => (
          <div
            key={g}
            style={{
              position: "absolute",
              left: 0,
              right: 0,
              top: H * g,
              height: 1,
              background: `${b.foreground}14`,
            }}
          />
        ))}
        {p.threshold !== null && (
          <>
            <div
              style={{
                position: "absolute",
                left: 0,
                right: 0,
                top: y(p.threshold),
                height: 2,
                background: `${danger}bb`,
                backgroundImage: `repeating-linear-gradient(90deg, ${danger}bb 0 10px, transparent 10px 18px)`,
              }}
            />
            <div
              style={{
                position: "absolute",
                right: 0,
                top: y(p.threshold) - 30,
                ...label,
                fontSize: 12,
                color: danger,
              }}
            >
              THRESHOLD {p.threshold}
            </div>
          </>
        )}
        <svg
          width={W}
          height={H}
          style={{ position: "absolute", inset: 0, overflow: "visible" }}
        >
          <polyline
            points={points.split(" ").slice(0, last).join(" ")}
            fill="none"
            stroke={color}
            strokeWidth={4}
            strokeLinejoin="round"
            strokeLinecap="round"
          />
        </svg>
        {shown.length > 0 && (
          <div
            style={{
              position: "absolute",
              left: x(last - 1) - 8,
              top: y(current) - 8,
              width: 16,
              height: 16,
              borderRadius: 9,
              background: color,
              boxShadow: `0 0 0 8px ${color}22`,
            }}
          />
        )}
        <div
          style={{
            position: "absolute",
            right: 0,
            top: -74,
            fontSize: 58,
            fontWeight: 640,
            letterSpacing: -2,
            color,
          }}
        >
          {Math.round(current * 100) / 100}
          <span style={{ fontSize: 26, opacity: 0.6, marginLeft: 8 }}>
            {p.unit}
          </span>
        </div>
      </div>
      <div
        style={{
          position: "absolute",
          left: 64,
          right: 64,
          bottom: 96,
          fontSize: 25,
          opacity: 0.62,
          ...fade(enter),
        }}
      >
        {"basis" in p && p.basis === "illustrative" && (
          <span
            style={{
              display: "inline-block",
              fontSize: 13,
              fontWeight: 640,
              letterSpacing: 2,
              color: b.foreground,
              border: `1px solid ${b.foreground}55`,
              borderRadius: 6,
              padding: "3px 10px",
              marginRight: 14,
              verticalAlign: 4,
            }}
          >
            ILLUSTRATIVE
          </span>
        )}
        {p.subtitle}
      </div>
    </>
  );
};

const FailureAnimationPrimitive: React.FC<PrimitiveProps> = ({
  p,
  b,
  f,
  fps,
  durationFrames,
  enter,
}) => {
  if (!("nodes" in p) || !("failedNode" in p)) return null;
  const seconds = f / fps;
  const total = durationFrames / fps;
  const failStart = total * 0.3;
  const cascadeEnd = total * (p.recovered ? 0.62 : 0.75);
  // Downstream nodes degrade progressively after the primary failure.
  const degraded = (i: number) =>
    seconds >
      failStart +
        (i - p.failedNode) *
          Math.max(0.25, (cascadeEnd - failStart) / p.nodes.length) &&
    i >= p.failedNode;
  const recovering = p.recovered && seconds > cascadeEnd;
  return (
    <>
      <div style={{ position: "absolute", left: 64, top: 112, right: 64 }}>
        <Heading title={p.title} enter={enter} accent={b.accent} small />
      </div>
      <div
        style={{
          position: "absolute",
          left: 64,
          right: 64,
          top: 300,
          height: 170,
          display: "flex",
          alignItems: "center",
        }}
      >
        {p.nodes.map((node, i) => {
          const isFailed = degraded(i) && !recovering;
          const isSource = i === p.failedNode;
          const pulse = isFailed ? 1 + 0.04 * Math.sin(seconds * 9) : 1;
          return (
            <React.Fragment key={i}>
              {i > 0 && (
                <div
                  style={{
                    flex: "0 0 44px",
                    height: 2,
                    background: degraded(i - 1)
                      ? `${danger}${isFailed ? "cc" : "77"}`
                      : `${b.accent}45`,
                    position: "relative",
                  }}
                >
                  {seconds > failStart && i === p.failedNode && !recovering && (
                    <div
                      style={{
                        position: "absolute",
                        width: 8,
                        height: 8,
                        borderRadius: 5,
                        background: danger,
                        top: -4,
                        left: (((seconds - failStart) * 0.9) % 1) * 36,
                      }}
                    />
                  )}
                </div>
              )}
              <div
                style={{
                  flex: 1,
                  minWidth: 0,
                  height: 150,
                  transform: `scale(${pulse})`,
                  border: `1.5px solid ${isFailed ? danger : recovering && isSource ? b.accent : b.accent + "65"}`,
                  background: isFailed ? dangerBg : panelBg,
                  borderRadius: 14,
                  padding: "20px 16px",
                  boxSizing: "border-box",
                  ...fade(Math.min(1, enter * 1.4 - i * 0.1)),
                }}
              >
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 8,
                    ...label,
                    fontSize: 12,
                    marginBottom: 18,
                    color: isFailed ? danger : b.accent,
                  }}
                >
                  <div
                    style={{
                      width: 10,
                      height: 10,
                      borderRadius: 6,
                      background: isFailed ? danger : b.accent,
                      opacity: isFailed
                        ? 0.5 + 0.5 * Math.sin(seconds * 10)
                        : 1,
                    }}
                  />
                  {isFailed
                    ? isSource
                      ? "PRIMARY FAILURE"
                      : "DEGRADED"
                    : recovering && isSource
                      ? "RECOVERED"
                      : "HEALTHY"}
                </div>
                <div
                  style={{
                    fontSize: 24,
                    fontWeight: 500,
                    overflowWrap: "anywhere",
                  }}
                >
                  {node}
                </div>
              </div>
            </React.Fragment>
          );
        })}
      </div>
      <div
        style={{
          position: "absolute",
          left: 64,
          right: 64,
          bottom: 100,
          fontSize: 25,
          opacity: 0.62,
          ...fade(enter),
        }}
      >
        {p.subtitle}
      </div>
    </>
  );
};

const PlaceholderPrimitive: React.FC<PrimitiveProps> = ({ b, enter }) => (
  <div
    style={{
      position: "absolute",
      inset: 0,
      ...fade(enter),
    }}
  >
    <div
      style={{
        position: "absolute",
        left: 70,
        top: 145,
        width: 550,
        fontSize: 50,
        lineHeight: 1.1,
        fontWeight: 600,
      }}
    >
      Why redundancy
      <br />
      is not high
      <br />
      <span style={{ color: b.accent }}>availability.</span>
    </div>
    <div
      style={{
        position: "absolute",
        left: 72,
        top: 422,
        width: 480,
        fontSize: 23,
        lineHeight: 1.45,
        opacity: 0.55,
      }}
    >
      Synthetic A-roll placeholder
      <br />
      Generated locally. No real person.
    </div>
    <div
      style={{
        position: "absolute",
        right: 170,
        top: 155,
        width: 145,
        height: 175,
        borderRadius: "48% 48% 44% 44%",
        background: "#355064",
      }}
    />
    <div
      style={{
        position: "absolute",
        right: 63,
        top: 348,
        width: 355,
        height: 235,
        borderRadius: "46% 46% 10% 10%",
        background: "#263c50",
      }}
    />
    <div
      style={{
        position: "absolute",
        right: 120,
        top: 568,
        width: 250,
        height: 12,
        borderRadius: 10,
        background: b.accent,
        opacity: 0.6,
      }}
    />
  </div>
);

export const Visual: React.FC<VisualProps> = (props) => {
  const f = useCurrentFrame();
  const { width, height } = useVideoConfig();
  const p = props.parameters,
    b = props.brand;
  const enter = interpolate(
    f,
    [0, Math.min(18, props.durationFrames / 3)],
    [0, 1],
    { extrapolateRight: "clamp" },
  );
  const primitiveProps: PrimitiveProps = {
    p,
    b,
    f,
    fps: props.fps,
    durationFrames: props.durationFrames,
    enter,
  };
  const footerTag =
    props.template === "Placeholder"
      ? "DEMO / SYNTHETIC MEDIA"
      : props.template === "ArchitectureFlow" ||
          props.template === "ArchitectureDiagram"
        ? "ARCHITECTURE / FLOW"
        : props.template === "RequestFlow" ||
            props.template === "FailureAnimation"
          ? "SYSTEMS / BEHAVIOUR"
          : props.template === "CodeReveal" ||
              props.template === "Terminal" ||
              props.template === "CodeDiff"
            ? "CODE / EVIDENCE"
            : props.template === "MetricChart"
              ? "MEASUREMENT"
              : props.template === "Quote"
                ? "VERBATIM"
                : "IDEA / EXPLANATION";
  return (
    <AbsoluteFill
      style={{
        background: b.background,
        color: b.foreground,
        fontFamily: b.fontFamily,
        overflow: "hidden",
      }}
    >
      <div
        style={{
          width: 1280,
          height: 720,
          transform: `scale(${width / 1280},${height / 720})`,
          transformOrigin: "top left",
          position: "absolute",
        }}
      >
        <div
          style={{
            position: "absolute",
            inset: 0,
            backgroundImage: `linear-gradient(${b.foreground}06 1px, transparent 1px),linear-gradient(90deg,${b.foreground}06 1px,transparent 1px)`,
            backgroundSize: "64px 64px",
          }}
        />
        <div
          style={{
            position: "absolute",
            top: 44,
            left: 64,
            ...label,
            color: b.accent,
          }}
        >
          WinTheCloud{" "}
          <span style={{ color: b.foreground, opacity: 0.45 }}>
            {" "}
            / SYSTEM NOTES
          </span>
        </div>
        <div
          style={{
            position: "absolute",
            top: 44,
            right: 64,
            ...label,
            opacity: 0.35,
          }}
        >
          PRODUCTION STUDY
        </div>
        {props.template === "ChapterTitle" ? (
          <ChapterTitlePrimitive {...primitiveProps} />
        ) : props.template === "Quote" ? (
          <QuotePrimitive {...primitiveProps} />
        ) : props.template === "ArchitectureFlow" ? (
          <ArchitectureFlowPrimitive {...primitiveProps} />
        ) : props.template === "ArchitectureDiagram" ? (
          <ArchitectureDiagramPrimitive {...primitiveProps} />
        ) : props.template === "RequestFlow" ? (
          <RequestFlowPrimitive {...primitiveProps} />
        ) : props.template === "CodeReveal" ? (
          <CodeRevealPrimitive {...primitiveProps} />
        ) : props.template === "Terminal" ? (
          <TerminalPrimitive {...primitiveProps} />
        ) : props.template === "CodeDiff" ? (
          <CodeDiffPrimitive {...primitiveProps} />
        ) : props.template === "MetricChart" ? (
          <MetricChartPrimitive {...primitiveProps} />
        ) : props.template === "FailureAnimation" ? (
          <FailureAnimationPrimitive {...primitiveProps} />
        ) : props.template === "Placeholder" ? (
          <PlaceholderPrimitive {...primitiveProps} />
        ) : (
          <CalloutPrimitive {...primitiveProps} />
        )}
        <div
          style={{
            position: "absolute",
            left: 64,
            right: 64,
            bottom: 45,
            display: "flex",
            justifyContent: "space-between",
            ...label,
            fontSize: 12,
            color: b.foreground,
            opacity: 0.35,
          }}
        >
          <span>ENGINEERING, WITH INTENT.</span>
          <span>{footerTag}</span>
        </div>
        <div
          style={{
            position: "absolute",
            bottom: 0,
            left: 0,
            height: 3,
            width: `${(100 * f) / Math.max(1, props.durationFrames - 1)}%`,
            background: b.accent,
            opacity: 0.55,
          }}
        />
      </div>
    </AbsoluteFill>
  );
};

const Root = () => (
  <Composition
    id="WinTheCloudVisual"
    component={Visual}
    defaultProps={defaults}
    durationInFrames={180}
    fps={30}
    width={1280}
    height={720}
    calculateMetadata={({ props }) => ({
      durationInFrames: props.durationFrames,
      fps: props.fps,
      width: props.width,
      height: props.height,
    })}
  />
);
registerRoot(Root);
