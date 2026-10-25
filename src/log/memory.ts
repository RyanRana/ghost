import type { GhostHeld, GhostLog, GhostWrite, NewHeld, NewWrite } from "./types.js"

const stamp = () => new Date().toISOString()

/** A session that lives as long as the process: tests, scripts, a one-off agent run. */
export class MemoryGhostLog implements GhostLog {
  readonly store = "memory" as const
  private started = stamp()
  private seq = 0
  private written: GhostWrite[] = []
  private sends: GhostHeld[] = []
  constructor(readonly id: string) {}
  async startedAt() { return this.started }
  async addWrite(write: NewWrite) { this.written.push({ ...write, seq: ++this.seq, at: stamp() }) }
  async writes() { return [...this.written] }
  async addHeld(held: NewHeld) { this.sends.push({ ...held, seq: ++this.seq, at: stamp() }) }
  async held() { return [...this.sends] }
  async reset() {
    this.written = []
    this.sends = []
    this.started = stamp()
  }
  async end() { await this.reset() }
}
