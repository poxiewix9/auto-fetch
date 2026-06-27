"use client";

import { useMemo } from "react";
import type { Application, Stage } from "@/lib/types";

type FNode = {
  id: string;
  label: string;
  value: number;
  layer: number;
  color: string;
};
type FLink = { source: string; target: string; value: number; color: string };

const C = {
  ink: "#1a1916",
  gray: "#9b9990",
  blue: "#5b7aa8",
  clay: "#b06a5f",
  green: "#5a8a6b",
  greenStrong: "#2f8f5b",
  declined: "#7a756c",
};

function buildModel(apps: Application[]): { nodes: FNode[]; links: FLink[] } {
  let interviewed = 0,
    rejectedNoInterview = 0,
    awaiting = 0,
    offers = 0,
    noOffer = 0,
    interviewing = 0,
    accepted = 0,
    declined = 0,
    offerPending = 0;

  for (const a of apps) {
    const set = new Set<Stage>([
      a.stage,
      ...((a.application_events ?? []).map((e) => e.stage) as Stage[]),
    ]);
    const reachedInterview =
      set.has("interview") || set.has("offer") || set.has("accepted") || set.has("declined");
    const reachedOffer = set.has("offer") || set.has("accepted") || set.has("declined");
    const rejected = a.stage === "rejected";

    if (reachedInterview) interviewed++;
    else if (rejected) rejectedNoInterview++;
    else awaiting++;

    if (reachedInterview) {
      if (reachedOffer) offers++;
      else if (rejected) noOffer++;
      else interviewing++;
    }
    if (reachedOffer) {
      if (a.stage === "accepted") accepted++;
      else if (a.stage === "declined") declined++;
      else offerPending++;
    }
  }

  const total = apps.length;
  const nodes: FNode[] = [];
  const links: FLink[] = [];
  const add = (n: FNode) => {
    if (n.value > 0) nodes.push(n);
  };
  const link = (source: string, target: string, value: number, color: string) => {
    if (value > 0) links.push({ source, target, value, color });
  };

  add({ id: "apps", label: "Applications", value: total, layer: 0, color: C.ink });
  add({ id: "interviewed", label: "Interviews", value: interviewed, layer: 1, color: C.blue });
  add({ id: "awaiting", label: "No answer", value: awaiting, layer: 1, color: C.gray });
  add({ id: "rejected", label: "Rejected", value: rejectedNoInterview, layer: 1, color: C.clay });
  add({ id: "offers", label: "Offers", value: offers, layer: 2, color: C.green });
  add({ id: "interviewing", label: "In process", value: interviewing, layer: 2, color: C.blue });
  add({ id: "noOffer", label: "No offer", value: noOffer, layer: 2, color: C.clay });
  add({ id: "accepted", label: "Accepted", value: accepted, layer: 3, color: C.greenStrong });
  add({ id: "declined", label: "Declined", value: declined, layer: 3, color: C.declined });
  add({ id: "offerPending", label: "Deciding", value: offerPending, layer: 3, color: C.green });

  link("apps", "interviewed", interviewed, C.blue);
  link("apps", "awaiting", awaiting, C.gray);
  link("apps", "rejected", rejectedNoInterview, C.clay);
  link("interviewed", "offers", offers, C.green);
  link("interviewed", "interviewing", interviewing, C.blue);
  link("interviewed", "noOffer", noOffer, C.clay);
  link("offers", "accepted", accepted, C.greenStrong);
  link("offers", "declined", declined, C.declined);
  link("offers", "offerPending", offerPending, C.green);

  return { nodes, links };
}

function ribbon(x0: number, y0: number, x1: number, y1: number, w: number): string {
  const xm = (x0 + x1) / 2;
  return `M${x0},${y0} C${xm},${y0} ${xm},${y1} ${x1},${y1} L${x1},${y1 + w} C${xm},${y1 + w} ${xm},${y0 + w} ${x0},${y0 + w} Z`;
}

export function FunnelView({ apps }: { apps: Application[] }) {
  const { nodes, links } = useMemo(() => buildModel(apps), [apps]);

  const W = 960;
  const H = 420;
  const leftLabel = 132;
  const rightLabel = 150;
  const nodeW = 13;
  const gap = 18;
  const margin = 24;

  const layout = useMemo(() => {
    const maxLayer = Math.max(0, ...nodes.map((n) => n.layer));
    const usableW = W - leftLabel - rightLabel - nodeW;
    const layerX = (l: number) => leftLabel + (maxLayer ? (l / maxLayer) * usableW : 0);

    const byLayer = new Map<number, FNode[]>();
    for (const n of nodes) {
      const list = byLayer.get(n.layer) ?? [];
      list.push(n);
      byLayer.set(n.layer, list);
    }

    let maxLayerSum = 1;
    let maxNodes = 1;
    for (const list of byLayer.values()) {
      maxLayerSum = Math.max(maxLayerSum, list.reduce((s, n) => s + n.value, 0));
      maxNodes = Math.max(maxNodes, list.length);
    }
    const scale = (H - 2 * margin - gap * (maxNodes - 1)) / maxLayerSum;

    const pos = new Map<string, { x: number; y: number; h: number; color: string }>();
    for (const [layer, list] of byLayer) {
      const colH = list.reduce((s, n) => s + n.value * scale, 0) + gap * (list.length - 1);
      let y = (H - colH) / 2;
      for (const n of list) {
        const h = n.value * scale;
        pos.set(n.id, { x: layerX(layer), y, h, color: n.color });
        y += h + gap;
      }
    }

    // Stack ribbon offsets at each node edge.
    const srcOff = new Map<string, number>();
    const tgtOff = new Map<string, number>();
    const paths = links.map((lk) => {
      const s = pos.get(lk.source)!;
      const t = pos.get(lk.target)!;
      const w = Math.max(lk.value * scale, 2.5); // keep tiny flows visible
      const so = srcOff.get(lk.source) ?? 0;
      const to = tgtOff.get(lk.target) ?? 0;
      srcOff.set(lk.source, so + w);
      tgtOff.set(lk.target, to + w);
      return {
        d: ribbon(s.x + nodeW, s.y + so, t.x, t.y + to, w),
        color: lk.color,
      };
    });

    return { pos, paths, layerX, maxLayer };
  }, [nodes, links]);

  return (
    <div className="rounded-2xl border border-line bg-paper-raised p-5">
      <p className="eyebrow mb-1 px-1">Application flow</p>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="h-auto w-full"
        style={{ maxHeight: 460 }}
        preserveAspectRatio="xMidYMid meet"
      >
        {layout.paths.map((p, i) => (
          <path key={i} d={p.d} fill={p.color} fillOpacity={0.4} />
        ))}
        {nodes.map((n) => {
          const p = layout.pos.get(n.id)!;
          const isLeft = n.layer === 0;
          const h = Math.max(p.h, 3);
          return (
            <g key={n.id}>
              <rect x={p.x} y={p.y} width={nodeW} height={h} rx={3} fill={n.color} />
              <text
                x={isLeft ? p.x - 10 : p.x + nodeW + 10}
                y={p.y + h / 2}
                textAnchor={isLeft ? "end" : "start"}
                dominantBaseline="middle"
                fontSize={13.5}
                fill="#1a1916"
              >
                <tspan fontWeight={600}>{n.label}</tspan>
                <tspan fill="#9a988e" fontWeight={400}>
                  {"  "}
                  {n.value}
                </tspan>
              </text>
            </g>
          );
        })}
      </svg>
      <p className="mt-3 border-t border-line px-1 pt-3 text-[11px] leading-relaxed text-faint">
        Reconstructed from each application&apos;s email history. &ldquo;No answer&rdquo; means
        applied or assessment stage with no further reply yet.
      </p>
    </div>
  );
}
