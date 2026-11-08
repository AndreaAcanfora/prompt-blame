// Keeps every relevant transcript parsed and up to date, reading only what was appended.

import * as fs from 'node:fs';
import * as path from 'node:path';
import { Edit, Session, TranscriptParser, claudeDir, findTranscripts } from './transcripts';

interface Entry {
  parser: TranscriptParser;
  offset: number;
  mtimeMs: number;
}

const CHUNK = 4 * 1024 * 1024;

export class TranscriptIndex {
  private entries = new Map<string, Entry>();
  private byFile = new Map<string, Edit[]>();
  private sessions = new Map<string, Session>();

  constructor(private readonly projectsDir = path.join(claudeDir(), 'projects')) {}

  get transcriptCount(): number {
    return this.entries.size;
  }

  /** Re-scan transcripts related to `folders`. Returns true if anything changed. */
  async refresh(folders: string[]): Promise<boolean> {
    const files = new Set<string>();
    for (const f of folders) for (const t of findTranscripts(f, this.projectsDir)) files.add(t);
    let changed = false;
    for (const file of [...this.entries.keys()]) {
      if (!files.has(file)) {
        this.entries.delete(file);
        changed = true;
      }
    }
    for (const file of files) {
      try {
        if (await this.update(file)) changed = true;
      } catch {
        // unreadable transcript: skip it
      }
    }
    if (changed) this.rebuild();
    return changed;
  }

  private async update(file: string): Promise<boolean> {
    const st = await fs.promises.stat(file);
    let e = this.entries.get(file);
    if (e && st.size === e.offset && st.mtimeMs === e.mtimeMs) return false;
    if (!e || st.size < e.offset) {
      e = { parser: new TranscriptParser(file), offset: 0, mtimeMs: 0 };
      this.entries.set(file, e);
    }
    const fh = await fs.promises.open(file, 'r');
    try {
      const decoder = new TextDecoder();
      while (e.offset < st.size) {
        const len = Math.min(CHUNK, st.size - e.offset);
        const buf = Buffer.alloc(len);
        const { bytesRead } = await fh.read(buf, 0, len, e.offset);
        if (!bytesRead) break;
        e.parser.feed(decoder.decode(buf.subarray(0, bytesRead), { stream: true }));
        e.offset += bytesRead;
      }
      e.parser.feed(decoder.decode());
      e.parser.flush();
    } finally {
      await fh.close();
    }
    e.mtimeMs = st.mtimeMs;
    return true;
  }

  private rebuild(): void {
    this.byFile.clear();
    this.sessions.clear();
    for (const { parser } of this.entries.values()) {
      const { session, edits } = parser.result();
      if (!parser.file.includes(`${path.sep}subagents${path.sep}`) || !this.sessions.has(session.id)) this.sessions.set(session.id, session);
      for (const ed of edits) {
        let arr = this.byFile.get(ed.file);
        if (!arr) this.byFile.set(ed.file, (arr = []));
        arr.push(ed);
      }
    }
  }

  editsFor(file: string): Edit[] {
    return this.byFile.get(path.resolve(file)) ?? [];
  }

  session(id: string): Session | undefined {
    return this.sessions.get(id);
  }

  /** Files that have at least one AI edit, under `folder`. */
  filesUnder(folder: string): string[] {
    const root = path.resolve(folder) + path.sep;
    return [...this.byFile.keys()].filter((f) => f.startsWith(root));
  }
}
