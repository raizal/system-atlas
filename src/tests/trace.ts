// The requests of a Playwright trace (trace.zip): each HTTP request of the page, with the spec line
// of the action that was running when it went out. The atlas reads the zip itself (store and
// deflate, no zip64): it needs no new package.
//
// A trace has events in JSON lines:
//   *.trace    `before` (callId, startTime, stack) and `after` (callId, endTime) of each action
//   *.stacks   the stacks of the actions, if they are not in the events: { files, stacks: [[callId, [[file, line, column, fn]]]] }
//   *.network  `resource-snapshot` with the request, the response and `_monotonicTime`

import { readFileSync } from 'node:fs';
import { inflateRawSync } from 'node:zlib';
import type { SeenRequest } from './types.js';

/** The files of a zip: name → bytes. */
export function readZip(buf: Buffer): Map<string, Buffer> {
  const out = new Map<string, Buffer>();
  // The end of the central directory: the last 0x06054b50 in the last 64 KB.
  let end = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65_557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      end = i;
      break;
    }
  }
  if (end < 0) throw new Error('Not a zip file.');
  const count = buf.readUInt16LE(end + 10);
  let at = buf.readUInt32LE(end + 16);
  for (let n = 0; n < count && at + 46 <= buf.length; n++) {
    if (buf.readUInt32LE(at) !== 0x02014b50) break;
    const method = buf.readUInt16LE(at + 10);
    const size = buf.readUInt32LE(at + 20);
    const nameLen = buf.readUInt16LE(at + 28);
    const extraLen = buf.readUInt16LE(at + 30);
    const commentLen = buf.readUInt16LE(at + 32);
    const local = buf.readUInt32LE(at + 42);
    const name = buf.toString('utf8', at + 46, at + 46 + nameLen);
    at += 46 + nameLen + extraLen + commentLen;
    if (buf.readUInt32LE(local) !== 0x04034b50) continue;
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const data = buf.subarray(start, start + size);
    if (method === 0) out.set(name, Buffer.from(data));
    else if (method === 8) {
      try {
        out.set(name, inflateRawSync(data));
      } catch {
        // A broken entry: leave it out.
      }
    }
  }
  return out;
}

interface Frame {
  file: string;
  line: number;
}

interface Action {
  callId: string;
  start: number;
  end: number;
  stack: Frame[];
}

const lines = (b: Buffer | undefined): unknown[] => {
  if (!b) return [];
  const out: unknown[] = [];
  for (const l of b.toString('utf8').split('\n')) {
    if (l.trim() === '') continue;
    try {
      out.push(JSON.parse(l));
    } catch {
      // A line that is not JSON: leave it out.
    }
  }
  return out;
};

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
/** A frame of the test code, not of Playwright or a package. */
const own = (f: Frame) => !/[\\/]node_modules[\\/]|^node:|^internal[\\/]/.test(f.file);

function framesOf(v: unknown): Frame[] {
  if (!Array.isArray(v)) return [];
  const out: Frame[] = [];
  for (const f of v) {
    if (isRecord(f) && typeof f.file === 'string' && num(f.line) !== undefined) out.push({ file: f.file, line: f.line as number });
  }
  return out;
}

/** The requests of the trace files in a zip, in time order. */
export function traceRequests(files: Map<string, Buffer>): SeenRequest[] {
  const actions = new Map<string, Action>();
  const stacks = new Map<string, Frame[]>();
  const requests: Array<{ method: string; url: string; status?: number; time: number }> = [];
  for (const [name, buf] of files) {
    if (name.endsWith('.stacks')) {
      try {
        const s = JSON.parse(buf.toString('utf8')) as { files?: string[]; stacks?: Array<[unknown, unknown]> };
        for (const [id, frames] of s.stacks ?? []) {
          if (!Array.isArray(frames)) continue;
          const list: Frame[] = [];
          for (const f of frames) {
            if (Array.isArray(f) && typeof f[0] === 'number' && typeof f[1] === 'number' && s.files?.[f[0]]) list.push({ file: s.files[f[0]]!, line: f[1] });
          }
          stacks.set(String(id), list);
        }
      } catch {
        // A stacks file that is not JSON: no stacks.
      }
    } else if (name.endsWith('.trace')) {
      for (const e of lines(buf)) {
        if (!isRecord(e) || typeof e.callId !== 'string') continue;
        const id = `${name}\n${e.callId}`;
        if (e.type === 'before') {
          const start = num(e.startTime);
          if (start === undefined) continue;
          actions.set(id, { callId: e.callId, start, end: Number.POSITIVE_INFINITY, stack: framesOf(e.stack) });
        } else if (e.type === 'after') {
          const a = actions.get(id);
          const end = num(e.endTime);
          if (a && end !== undefined) a.end = end;
        }
      }
    } else if (name.endsWith('.network')) {
      for (const e of lines(buf)) {
        if (!isRecord(e) || e.type !== 'resource-snapshot' || !isRecord(e.snapshot)) continue;
        const s = e.snapshot;
        const req = isRecord(s.request) ? s.request : undefined;
        if (!req || typeof req.url !== 'string') continue;
        const time = num(s._monotonicTime) ?? (typeof s.startedDateTime === 'string' ? Date.parse(s.startedDateTime) : undefined);
        if (time === undefined || Number.isNaN(time)) continue;
        const status = isRecord(s.response) ? num(s.response.status) : undefined;
        requests.push({ method: typeof req.method === 'string' ? req.method.toUpperCase() : 'GET', url: req.url, time, ...(status !== undefined && status > 0 ? { status } : {}) });
      }
    }
  }
  const list = [...actions.values()].map((a) => ({ ...a, stack: a.stack.length > 0 ? a.stack : (stacks.get(a.callId) ?? []) }));
  const withCode = list.filter((a) => a.stack.some(own)).sort((a, b) => a.start - b.start);
  const t0 = Math.min(...list.map((a) => a.start), ...requests.map((r) => r.time));
  return requests
    .sort((a, b) => a.time - b.time)
    .map((r) => {
      // The innermost action that runs at the time of the request; else the last one that started before it.
      let hit: (typeof withCode)[number] | undefined;
      for (const a of withCode) {
        if (a.start > r.time) break;
        if (r.time <= a.end && (!hit || hit.end > a.end || hit.end < r.time)) hit = a;
        else if (!hit || (hit.end < r.time && a.start >= hit.start)) hit = a;
      }
      const frame = hit?.stack.find(own);
      return { method: r.method, url: r.url, ...(r.status !== undefined ? { status: r.status } : {}), ...(frame ? { file: frame.file, line: frame.line } : {}), at: Math.max(0, Math.round(r.time - t0)) };
    });
}

/** The requests of a trace.zip file; none if the atlas cannot read it. */
export function readTrace(path: string): SeenRequest[] {
  try {
    return traceRequests(readZip(readFileSync(path)));
  } catch {
    return [];
  }
}
