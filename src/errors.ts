import type { AgentProvider } from "./providers.js";

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

export type ProviderTurnErrorKind =
  | "usage_limit"
  | "provider_error"
  | "auth_required"
  | "unsupported"
  | "invalid_request";

export interface ProviderTurnErrorOptions {
  /** Defaults to "provider_error". */
  kind?: ProviderTurnErrorKind;
  /** The provider's own code, e.g. "RESOURCE_EXHAUSTED" or -32000. */
  code?: string | number;
  /** Whether sending the same turn again may succeed. Defaults to false. */
  retryable?: boolean;
  /** ISO time when a usage limit resets, when the provider says. */
  resetAt?: string;
  exitCode?: number;
  cause?: unknown;
}

/** A turn a provider failed, in one shape for every provider, so a host can
 * handle every failure in one place. Claude's failed results resolve with
 * exitCode 1 instead (see PROVIDER_CAPABILITIES' `failedTurn`). */
export class ProviderTurnError extends Error {
  override name: string = "ProviderTurnError";
  readonly provider: AgentProvider;
  readonly kind: ProviderTurnErrorKind;
  readonly code?: string | number;
  readonly retryable: boolean;
  readonly resetAt?: string;
  /** Exit code of the provider's process, once known. */
  exitCode?: number;

  constructor(provider: AgentProvider, message: string, options: ProviderTurnErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.provider = provider;
    this.kind = options.kind ?? "provider_error";
    this.retryable = options.retryable ?? false;
    if (options.code !== undefined) this.code = options.code;
    if (options.resetAt !== undefined) this.resetAt = options.resetAt;
    if (options.exitCode !== undefined) this.exitCode = options.exitCode;
  }
}

/** A fatal `error` / `turn.failed` event in the Codex JSONL stream. */
export class CodexTurnError extends ProviderTurnError {
  override name = "CodexTurnError";
  constructor(message: string, options?: ProviderTurnErrorOptions) {
    super("codex", message, options);
  }
}

export interface AgyTurnErrorOptions extends ProviderTurnErrorOptions {
  /** The ACP stop reason the prompt ended with, when it ended with one. */
  stopReason?: string;
  /** agy's saved conversation can no longer be sent to the model: start a
   * fresh session. */
  broken?: boolean;
  /** The turn's last assistant prose. */
  text?: string;
}

/** A failed agy turn: an error agy logged, a stop reason other than
 * `end_turn`, or a request the session refused. */
export class AgyTurnError extends ProviderTurnError {
  override name = "AgyTurnError";
  readonly stopReason?: string;
  readonly broken: boolean;
  readonly text?: string;
  constructor(message: string, options: AgyTurnErrorOptions = {}) {
    super("agy", message, options);
    this.broken = options.broken ?? false;
    if (options.stopReason !== undefined) this.stopReason = options.stopReason;
    if (options.text !== undefined) this.text = options.text;
  }
}

/** agy needs the user to sign in (`agy`, or `agy acp --login`). */
export class AgyAuthError extends ProviderTurnError {
  override name = "AgyAuthError";
  /** The sign-in link agy printed, when it printed one. */
  readonly url?: string;
  readonly data?: unknown;
  constructor(message: string, options: { code?: number; url?: string; data?: unknown } = {}) {
    super("agy", message, {
      kind: "auth_required",
      ...(options.code !== undefined ? { code: options.code } : {}),
    });
    if (options.url !== undefined) this.url = options.url;
    if (options.data !== undefined) this.data = options.data;
  }
}

/** Thrown by a {@link CodexServerRequestHandler} for a method it does not
 * take: the server gets "method not found", as if nothing were registered. */
export class UnsupportedServerRequestError extends Error {
  constructor(method: string) {
    super(`Unsupported server request: ${method}`);
    this.name = "UnsupportedServerRequestError";
  }
}

/** A steer the session could not hand to the running turn: none is running,
 * or the turn is past the point of taking more input. The host can send the
 * same words as the next turn instead. */
export class SteerRejectedError extends Error {
  override readonly name = "SteerRejectedError";
}

/** The error a run stopped by its signal rejects with, e.g. "codex run aborted". */
export function runAborted(cli: string): AbortError {
  return new AbortError(`${cli} run aborted`);
}

/** The error a run stopped by its timeout rejects with. */
export function runTimedOut(cli: string, timeoutMs: number | undefined): TimeoutError {
  return new TimeoutError(`${cli} run timed out after ${timeoutMs}ms`);
}
