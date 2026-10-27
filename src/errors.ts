export class AbortError extends Error {
  override readonly name = "AbortError";
  constructor(message = "Aborted") {
    super(message);
  }
}

export class TimeoutError extends Error {
  override readonly name = "TimeoutError";
  constructor(message = "Timed out") {
    super(message);
  }
}

export class MissingCliError extends Error {
  override readonly name = "MissingCliError";
  readonly cli: string;
  constructor(cli: string) {
    super(`\`${cli}\` CLI not found. Install it and make sure it is on your PATH.`);
    this.cli = cli;
  }
}

/** A fatal `error` / `turn.failed` event in the Codex JSONL stream. */
export class CodexTurnError extends Error {
  override readonly name = "CodexTurnError";
  /** Exit code of the Codex process, once known. */
  exitCode?: number;
}

/** A steer the session could not hand to the running turn: none is running,
 * or the turn is past the point of taking more input. The host can send the
 * same words as the next turn instead. */
export class SteerRejectedError extends Error {
  override readonly name = "SteerRejectedError";
}
