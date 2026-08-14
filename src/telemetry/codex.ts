/**
 * Codex `exec` prints a final, provider-published total as two terminal
 * lines: `tokens used` and a number. This parser retains neither the prompt
 * nor response: it recognises those two exact lines, keeps at most one short
 * incomplete line while a stream chunk is split, and returns just a number.
 */
const ANSI_ESCAPE = /\u001B\[[0-?]*[ -/]*[@-~]/g;
const MAX_INCOMPLETE_LINE = 128;

function parseTotal(line: string): number | undefined {
  if (!/^\d[\d,]*$/.test(line)) return undefined;
  const total = Number(line.replaceAll(",", ""));
  return Number.isSafeInteger(total) && total >= 0 ? total : undefined;
}

export class CodexExecTokenParser {
  private pending = "";
  private expectsTotal = false;
  private total: number | undefined;

  accept(chunk: Buffer | string): void {
    const text = this.pending + (typeof chunk === "string" ? chunk : chunk.toString("utf8"));
    const lines = text.split(/\r?\n/);
    this.pending = lines.pop() ?? "";
    if (this.pending.length > MAX_INCOMPLETE_LINE) this.pending = "";
    for (const line of lines) this.acceptLine(line);
  }

  finish(): number | undefined {
    if (this.pending) this.acceptLine(this.pending);
    this.pending = "";
    return this.total;
  }

  private acceptLine(line: string): void {
    const normalized = line.replace(ANSI_ESCAPE, "").trim();
    if (normalized === "tokens used") {
      this.expectsTotal = true;
      return;
    }
    if (this.expectsTotal) {
      this.expectsTotal = false;
      const total = parseTotal(normalized);
      if (total !== undefined) this.total = total;
    }
  }
}

/** `codex exec` is non-interactive, so piped output cannot alter its TTY UI. */
export function isCodexExec(args: string[]): boolean {
  return args[0] === "exec";
}
