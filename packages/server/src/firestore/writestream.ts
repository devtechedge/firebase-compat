// Transport-independent Write stream: a handshake request yields a stream token, then each
// request with writes is committed atomically and acknowledged with the next token.
import { randomBytes } from "node:crypto";
import type { AccessContext, FirestoreEngine, Write } from "./engine.js";

export interface WriteRequest { database?: string; streamId?: string; streamToken?: string; writes?: Write[]; labels?: Record<string, string> }

export class WriteSession {
  readonly streamId = randomBytes(8).toString("hex");
  private counter = 0;
  private handshaken = false;

  constructor(private engine: FirestoreEngine, private ctx: () => AccessContext) {}

  private token(): string {
    return Buffer.from(String(this.counter++)).toString("base64");
  }

  /** Returns the response message; throws RpcError when the commit fails (stream must close). */
  handle(req: WriteRequest): Record<string, unknown> {
    if (!this.handshaken) {
      this.handshaken = true;
      if (!req.writes?.length) return { streamId: this.streamId, streamToken: this.token() };
    }
    const result = this.engine.commit(req.writes ?? [], this.ctx());
    return { streamToken: this.token(), writeResults: result.writeResults, commitTime: result.commitTime };
  }
}
