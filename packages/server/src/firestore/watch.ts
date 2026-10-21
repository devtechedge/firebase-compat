// Transport-independent implementation of the Firestore Listen protocol. A WatchSession owns the
// targets of one Listen stream and emits ListenResponse messages (proto3 JSON form).
import { RpcError } from "../util/status.js";
import type { AccessContext, FirestoreEngine } from "./engine.js";
import { timestampMicros } from "./engine.js";
import type { Doc, StructuredQuery } from "./query.js";

export interface Target {
  targetId: number;
  query?: { parent: string; structuredQuery: StructuredQuery };
  documents?: { documents: string[] };
  resumeToken?: string;
  readTime?: string;
  once?: boolean;
}
export interface ListenRequest { database?: string; addTarget?: Target; removeTarget?: number; labels?: Record<string, string> }
export type ListenResponse = Record<string, unknown>;

export function resumeTokenFor(readTime: string): string {
  return Buffer.from(String(timestampMicros(readTime))).toString("base64");
}

interface Active { target: Target; docs: Map<string, string> }

export class WatchSession {
  private targets = new Map<number, Active>();
  private unsubscribe: () => void;

  constructor(private engine: FirestoreEngine, private ctx: () => AccessContext, private send: (m: ListenResponse) => void) {
    this.unsubscribe = engine.onChange((changed, readTime) => this.onChange(changed, readTime));
  }

  handle(req: ListenRequest): void {
    if (req.addTarget) this.add(req.addTarget);
    if (req.removeTarget !== undefined) this.remove(Number(req.removeTarget));
  }

  close(): void {
    this.unsubscribe();
    this.targets.clear();
  }

  private evaluate(t: Target): Doc[] {
    if (t.query) return this.engine.query(t.query.parent, t.query.structuredQuery, this.ctx());
    return (t.documents?.documents ?? []).map((n) => this.engine.checkRead(n, this.ctx())).filter((d): d is Doc => !!d);
  }

  private add(t: Target): void {
    const id = Number(t.targetId);
    this.send({ targetChange: { targetChangeType: "ADD", targetIds: [id] } });
    let docs: Doc[];
    try {
      docs = this.evaluate(t);
    } catch (e) {
      const err = e instanceof RpcError ? e : new RpcError("INTERNAL", String(e));
      this.send({ targetChange: { targetChangeType: "REMOVE", targetIds: [id], cause: { code: err.code, message: err.message } } });
      return;
    }
    const active: Active = { target: { ...t, targetId: id }, docs: new Map() };
    this.targets.set(id, active);
    for (const d of docs) {
      active.docs.set(d.name, d.updateTime);
      this.send({ documentChange: { document: d, targetIds: [id] } });
    }
    if (t.resumeToken || t.readTime) this.send({ filter: { targetId: id, count: docs.length } });
    const readTime = this.engine.clock.now();
    const token = resumeTokenFor(readTime);
    this.send({ targetChange: { targetChangeType: "CURRENT", targetIds: [id], resumeToken: token, readTime } });
    this.send({ targetChange: { resumeToken: token, readTime } });
  }

  private remove(id: number): void {
    if (this.targets.delete(id)) this.send({ targetChange: { targetChangeType: "REMOVE", targetIds: [id] } });
    else this.send({ targetChange: { targetChangeType: "REMOVE", targetIds: [id] } });
  }

  private onChange(changed: Map<string, Doc | null>, readTime: string): void {
    let any = false;
    for (const [id, active] of this.targets) {
      let docs: Doc[];
      try {
        docs = this.evaluate(active.target);
      } catch (e) {
        const err = e instanceof RpcError ? e : new RpcError("INTERNAL", String(e));
        this.targets.delete(id);
        this.send({ targetChange: { targetChangeType: "REMOVE", targetIds: [id], cause: { code: err.code, message: err.message } } });
        any = true;
        continue;
      }
      const next = new Map(docs.map((d) => [d.name, d.updateTime]));
      for (const d of docs) {
        if (active.docs.get(d.name) !== d.updateTime) {
          this.send({ documentChange: { document: d, targetIds: [id] } });
          any = true;
        }
      }
      for (const name of active.docs.keys()) {
        if (next.has(name)) continue;
        any = true;
        if (changed.has(name) && changed.get(name) === null) this.send({ documentDelete: { document: name, removedTargetIds: [id], readTime } });
        else this.send({ documentRemove: { document: name, removedTargetIds: [id], readTime } });
      }
      active.docs = next;
    }
    if (any) this.send({ targetChange: { resumeToken: resumeTokenFor(readTime), readTime } });
  }
}
