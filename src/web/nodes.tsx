// The node and group shapes of the canvas. Each node is drawn at the size the layout gave it.
// A closed box has a "+" button; an open box is a container with a head (the name, the file and a
// "−" button) and its view inside. A double-click opens or closes a box.

import { Handle, Position, type NodeProps, type Node } from '@xyflow/react';
import type { ViewGroup, ViewNode } from '../server/view.js';
import type { BoxState } from './tree.js';

export interface AtlasNodeData extends Record<string, unknown> {
  node: ViewNode;
  /** The full ID of the box on the canvas. */
  fid: string;
  lines: string[];
  state: BoxState;
  onToggle: (fid: string) => void;
  onTarget: (fid: string, n: ViewNode) => void;
  /** Collapse or expand a group (a collapsed group is a node). */
  onFold: (fid: string) => void;
  /** The icon of a collapsed group. */
  icon?: string;
  /** Small marks on the corner of the box: a mock, an assert result, a count of test cases. */
  badges?: NodeBadge[];
  /** The player of the Tests mode: lit (the current step or its target), played (an earlier step), or dim. */
  play?: 'lit' | 'played' | 'dim';
}

export interface NodeBadge {
  /** mock: the step mocks the endpoint. pass, fail: the result of the step. cover: test cases; none: no test case. */
  kind: 'mock' | 'pass' | 'fail' | 'cover' | 'none';
  text: string;
  title: string;
  onClick?: () => void;
}

function Badges({ list }: { list: NodeBadge[] | undefined }) {
  if (!list || list.length === 0) return null;
  return (
    <span className="badges">
      {list.map((b) =>
        b.onClick ? (
          <button
            key={b.kind}
            type="button"
            className={`badge badge-${b.kind}`}
            data-testid={`badge-${b.kind}`}
            title={b.title}
            onClick={(e) => {
              e.stopPropagation();
              b.onClick!();
            }}
          >
            {b.text}
          </button>
        ) : (
          <span key={b.kind} className={`badge badge-${b.kind}`} data-testid={`badge-${b.kind}`} title={b.title}>
            {b.text}
          </span>
        ),
      )}
    </span>
  );
}

export interface GroupData extends Record<string, unknown> {
  group: ViewGroup;
  fid: string;
  compact: boolean;
  onFold: (fid: string) => void;
  onCompact: (fid: string) => void;
}

export const TONES = ['blue', 'green', 'violet', 'amber', 'pink', 'teal', 'orange', 'slate'] as const;
export const toneOf = (t: number | undefined): string => TONES[(t ?? 7) % TONES.length]!;

export function Icon({ name }: { name: string }) {
  const paths: Record<string, string> = {
    frontend: 'M2 3h12v8H2z M5 14h6 M8 11v3',
    page: 'M4 2h6l3 3v9H4z M10 2v3h3',
    api: 'M3 5h10 M3 8h10 M3 11h6 M12 10l2 2-2 2',
    cli: 'M3 4l4 4-4 4 M8 12h5',
    library: 'M3 3h3v10H3z M7 3h3v10H7z M11 4l2.5-.5 2 9.5-2.5.5z',
    store: 'M3 4c0-1.5 10-1.5 10 0v8c0 1.5-10 1.5-10 0z M3 4c0 1.5 10 1.5 10 0',
    worker: 'M9 2L4 9h4l-1 5 5-7H8z',
    project: 'M2 4h5l1 2h6v7H2z',
  };
  return (
    <svg className="icon" viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
      <path d={paths[name] ?? paths.project} fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}

export function GroupBox({ data }: NodeProps<Node<GroupData>>) {
  const g = data.group;
  return (
    <div className={`group tone-${toneOf(g.tone)}`} data-testid="group" data-group={g.id} data-id={data.fid}>
      {/* An edge can go to a group: the event handlers get one edge, not one for each. */}
      <Handle type="target" position={Position.Top} className="handle" />
      <div className="group-head">
        <Icon name={g.icon} />
        <span className="group-label" title={g.label}>{g.label}</span>
        <span className="group-buttons">
          <button
            type="button"
            className="group-button"
            data-testid="compact"
            aria-pressed={data.compact}
            aria-label={data.compact ? `Show ${g.label} as boxes` : `Show ${g.label} as names only`}
            title={data.compact ? 'Show the boxes' : 'Names only (compact)'}
            onClick={(e) => {
              e.stopPropagation();
              data.onCompact(data.fid);
            }}
          >
            ▦
          </button>
          <button
            type="button"
            className="group-button"
            data-testid="fold"
            aria-label={`Collapse ${g.label}`}
            title="Collapse the group to one row"
            onClick={(e) => {
              e.stopPropagation();
              data.onFold(data.fid);
            }}
          >
            −
          </button>
        </span>
      </div>
      <Handle type="source" position={Position.Bottom} className="handle" />
    </div>
  );
}

const MARK: Partial<Record<ViewNode['shape'], string>> = { loop: '↻', event: 'ϟ', lib: '◦', more: '…' };

function Methods({ method }: { method: string | undefined }) {
  return (
    <>
      {method?.split(' ').map((m) => (
        <span key={m} className={`method method-${m.toLowerCase()}`} data-testid="method">
          {m}
        </span>
      ))}
    </>
  );
}

/** The button that opens the box of the endpoint of an HTTP call, in place, and selects it. */
function TargetButton({ data }: { data: AtlasNodeData }) {
  const n = data.node;
  if (!n.target) return null;
  return (
    <button
      type="button"
      className="target"
      data-testid="target"
      title="Open the endpoint of this HTTP call"
      aria-label={`Open the endpoint of ${n.label}`}
      onClick={(e) => {
        e.stopPropagation();
        data.onTarget(data.fid, n);
      }}
    >
      ⇢
    </button>
  );
}

export function AtlasNode({ data, selected }: NodeProps<Node<AtlasNodeData>>) {
  const n = data.node;
  const tone = toneOf(n.tone);
  const end = n.shape === 'end' && n.sub?.startsWith('throw') ? ' throw' : '';
  const loading = data.state === 'loading';
  return (
    <div
      className={`node shape-${n.shape} tone-${tone}${end}${n.size ? ` size-${n.size}` : ''}${selected ? ' selected' : ''}${n.open ? ' can-open' : ''}${loading ? ' loading' : ''}`}
      data-testid="node"
      data-shape={n.shape}
      data-id={data.fid}
      data-label={n.label}
      data-state={data.state}
      {...(data.play ? { 'data-play': data.play } : {})}
      title={`${n.method ? `${n.method} ` : ''}${n.label}${n.sub ? ` · ${n.sub}` : ''}${n.shape === 'fold' ? '\nDouble-click to expand the group' : n.open ? '\nDouble-click to open the box' : ''}`}
      onDoubleClick={n.shape === 'fold' ? () => data.onFold(data.fid) : n.open ? () => data.onToggle(data.fid) : undefined}
    >
      <Handle type="target" position={Position.Top} className="handle" />
      <Badges list={data.badges} />
      {n.shape === 'decision' && (
        <svg className="diamond" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
          <polygon points="50,1 99,50 50,99 1,50" />
        </svg>
      )}
      <div className="node-body">
        {data.icon && <span className="fold-icon"><Icon name={data.icon} /></span>}
        <div className="node-label">
          {MARK[n.shape] && <span className="mark">{MARK[n.shape]}</span>}
          {data.lines.map((l, i) => (
            <span key={i} className="line">
              {i === 0 && <Methods method={n.method} />}
              {l}
            </span>
          ))}
        </div>
        {n.sub && <div className="node-sub">{n.sub}</div>}
      </div>
      <div className="node-buttons">
        {n.shape === 'fold' && (
          <button
            type="button"
            className="open"
            data-testid="unfold"
            aria-label={`Expand ${n.label}`}
            title="Expand the group"
            onClick={(e) => {
              e.stopPropagation();
              data.onFold(data.fid);
            }}
          >
            +
          </button>
        )}
        <TargetButton data={data} />
        {n.open && (
          <button
            type="button"
            className="open"
            data-testid="open"
            aria-label={`Open ${n.label}`}
            title="Open the box in place"
            disabled={loading}
            onClick={(e) => {
              e.stopPropagation();
              data.onToggle(data.fid);
            }}
          >
            {loading ? '…' : '+'}
          </button>
        )}
      </div>
      <Handle type="source" position={Position.Bottom} className="handle" />
    </div>
  );
}

/** An open box: a head, and the view of the box inside it (the children are nodes of the canvas). */
export function BoxNode({ data, selected }: NodeProps<Node<AtlasNodeData>>) {
  const n = data.node;
  const where = n.file ? `${n.file}${n.line ? `:${n.line}` : ''}` : n.sub;
  return (
    <div className={`box shape-${n.shape} tone-${toneOf(n.tone)}${selected ? ' selected' : ''}`} data-testid="container" data-shape={n.shape} data-id={data.fid} data-state="open" {...(data.play ? { 'data-play': data.play } : {})}>
      <Handle type="target" position={Position.Top} className="handle" />
      <div className="box-head" title={`${n.method ? `${n.method} ` : ''}${n.label}\nDouble-click to close the box`} onDoubleClick={() => data.onToggle(data.fid)}>
        <div className="box-name">
          <span className="box-label">
            <Methods method={n.method} />
            <span className="box-text">{n.label}</span>
          </span>
          {where && <span className="box-where">{where}</span>}
        </div>
        <TargetButton data={data} />
        <button
          type="button"
          className="collapse"
          data-testid="collapse"
          aria-label={`Close ${n.label}`}
          title="Close the box"
          onClick={(e) => {
            e.stopPropagation();
            data.onToggle(data.fid);
          }}
        >
          −
        </button>
      </div>
      <Handle type="source" position={Position.Bottom} className="handle" />
    </div>
  );
}

export const nodeTypes = { atlas: AtlasNode, box: BoxNode, group: GroupBox };
