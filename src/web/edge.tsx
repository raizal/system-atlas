// The edges of the canvas. ELK routes each edge and places its label out of the boxes. This
// edge draws the ELK path with round corners, and the label as a pill with a white background.
// If ELK gave no path, the edge is a smooth step from handle to handle.

import { BaseEdge, EdgeLabelRenderer, getSmoothStepPath, type Edge, type EdgeProps } from '@xyflow/react';
import { useState } from 'react';
import type { Box, Point } from './layout.js';

export interface ElkEdgeData extends Record<string, unknown> {
  kind: string;
  label?: string;
  /** The text on hover of the label. */
  title?: string;
  points?: Point[];
  box?: Box;
  /** An edge between boxes in different open boxes, with a route out of the outer boxes. */
  cross?: boolean;
  /** The edge is faint: no end is hot. */
  faint?: boolean;
  /** import: hidden but for "Show imports"; total: the calls between two groups, only when the zoom is small. */
  role?: 'import' | 'total' | 'sum' | 'detail';
  /** No sure endpoint: dashed and lighter. */
  possible?: boolean;
  /** The label overlaps another label: it shows only when the pointer is on the edge. */
  hidden?: boolean;
  /** Out of the focus: the edge is almost gone and has no label. */
  dim?: boolean;
  /** The edge is in a bundle (one trunk into one target box). */
  bundle?: string;
  /** The label of the whole bundle (on one edge of the bundle). */
  bundleLabel?: { text: string; box: Box; hidden?: boolean };
  /** An edge of the bundle is in the focus or under the pointer: the bundle label stays. */
  bundleOn?: boolean;
  /** The link of the current step of the player: it moves. */
  live?: boolean;
}

/** An SVG path through the points, with a round corner of at most `r` at each bend. */
export function pathOf(points: Point[], r = 6): string {
  if (points.length === 0) return '';
  let d = `M ${points[0]!.x} ${points[0]!.y}`;
  for (let i = 1; i < points.length; i++) {
    const p = points[i]!;
    const next = points[i + 1];
    if (!next) {
      d += ` L ${p.x} ${p.y}`;
      break;
    }
    const prev = points[i - 1]!;
    const a = Math.min(r, Math.hypot(p.x - prev.x, p.y - prev.y) / 2, Math.hypot(next.x - p.x, next.y - p.y) / 2);
    const from = toward(p, prev, a);
    const to = toward(p, next, a);
    d += ` L ${from.x} ${from.y} Q ${p.x} ${p.y} ${to.x} ${to.y}`;
  }
  return d;
}

function toward(p: Point, q: Point, a: number): Point {
  const len = Math.hypot(q.x - p.x, q.y - p.y) || 1;
  return { x: p.x + ((q.x - p.x) / len) * a, y: p.y + ((q.y - p.y) / len) * a };
}

export function ElkEdge(props: EdgeProps<Edge<ElkEdgeData>>) {
  const { id, data, markerEnd, style } = props;
  const [hover, setHover] = useState(false);
  const points = data?.points;
  let path: string;
  let lx: number;
  let ly: number;
  if (points && points.length >= 2) {
    path = pathOf(points);
    lx = data.box ? data.box.x + data.box.width / 2 : (points[0]!.x + points.at(-1)!.x) / 2;
    ly = data.box ? data.box.y + data.box.height / 2 : (points[0]!.y + points.at(-1)!.y) / 2;
  } else {
    [path, lx, ly] = getSmoothStepPath({ ...props, borderRadius: 6 });
  }
  return (
    <>
      <g onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}>
        <BaseEdge id={id} path={path} {...(markerEnd ? { markerEnd } : {})} {...(style ? { style } : {})} />
        {data?.hidden && data.label && <title>{[data.label, data.title].filter(Boolean).join('\n')}</title>}
      </g>
      {data?.bundleLabel && (!data.dim || data.bundleOn) && (!data.bundleLabel.hidden || hover) && (
        <EdgeLabelRenderer>
          <div className={`edge-pill edge-${data.kind} edge-pill-bundle`} data-testid="bundle-label" title="All the links into this box: one line, one arrow. Select a box to see its own link." style={{ pointerEvents: 'auto', cursor: 'help', transform: `translate(${data.bundleLabel.box.x}px, ${data.bundleLabel.box.y}px)` }}>
            {data.bundleLabel.text}
          </div>
        </EdgeLabelRenderer>
      )}
      {data?.label && !data.dim && (!data.hidden || hover) && (
        <EdgeLabelRenderer>
          <div className={`edge-pill edge-${data.kind}${data.role ? ` edge-pill-${data.role}` : ''}${data.possible ? ' edge-pill-possible' : ''}${data.hidden ? ' edge-pill-hover' : ''}`} data-testid="edge-label" {...(data.title ? { title: data.title } : {})} style={{ ...(data.title ? { pointerEvents: 'auto' as const, cursor: 'help' } : {}), transform: `translate(-50%, -50%) translate(${lx}px, ${ly}px)` }}>
            {data.label}
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  );
}

export const edgeTypes = { elk: ElkEdge };
