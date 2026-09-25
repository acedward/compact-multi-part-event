/**
 * Complete wallet sync. A Midnight wallet is three sub-wallets (shielded, unshielded,
 * DUST), each fed by its own indexer subscription. The facade's `isSynced` flag is not
 * enough to rely on before reading balances: a first sync downloads every zswap and
 * DUST ledger event of the chain and can take a long time, and a flag read at the wrong
 * moment (before the indexer has reported how far it is, or from a stale report) must
 * not be taken as the end of it.
 *
 * "Synced" here means, for EVERY sub-wallet:
 * - it has heard from the indexer (`isConnected`), so the indexer's highest index is
 *   known;
 * - it has applied everything up to the highest index the indexer has reported to it
 *   during this wait (a report that goes backwards does not lower the target);
 * - and all three stay that way for several consecutive samples.
 *
 * The indices come from wallet-sdk 5.0.0-beta.2: shielded and DUST `progress.appliedIndex`
 * against `progress.highestRelevantWalletIndex` (the `maxId` the indexer sends with
 * every ledger event: the highest zswap or DUST ledger-event id it holds); unshielded
 * `progress.appliedId` against `progress.highestTransactionId` (the highest transaction
 * id the indexer holds for the address). They are public counters; progress lines hold
 * nothing else.
 *
 * @module
 */
import { type Observable, Subscription } from "rxjs";

/** Sync position of one sub-wallet (public counters only). */
export interface SubWalletProgress {
  /** Index of the last update the sub-wallet applied (0 before the first one). */
  readonly applied: bigint;
  /** Highest index the indexer has reported to the sub-wallet. */
  readonly highest: bigint;
  /** The sub-wallet has heard from the indexer at least once. */
  readonly connected: boolean;
}

/** The three sub-wallets, in the order progress is printed. */
export const SUB_WALLETS = ["shielded", "unshielded", "dust"] as const;

/** One of {@link SUB_WALLETS}. */
export type SubWallet = (typeof SUB_WALLETS)[number];

/** Sync position of a whole wallet. */
export type WalletSyncProgress = Readonly<Record<SubWallet, SubWalletProgress>>;

interface EventSyncProgress {
  readonly appliedIndex: bigint;
  readonly highestRelevantWalletIndex: bigint;
  readonly isConnected: boolean;
}

/**
 * The part of a wallet-sdk-facade 5.0.0-beta.2 `FacadeState` the sync check reads. A
 * `FacadeState` satisfies it as is.
 */
export interface SyncProgressSource {
  readonly shielded: { readonly progress: EventSyncProgress };
  readonly unshielded: {
    readonly progress: {
      readonly appliedId: bigint;
      readonly highestTransactionId: bigint;
      readonly isConnected: boolean;
    };
  };
  readonly dust: { readonly progress: EventSyncProgress };
}

const fromEvents = (progress: EventSyncProgress): SubWalletProgress => ({
  applied: progress.appliedIndex,
  highest: progress.highestRelevantWalletIndex,
  connected: progress.isConnected,
});

/** Read the sync position of every sub-wallet from a facade state. */
export const syncProgressOf = (state: SyncProgressSource): WalletSyncProgress => ({
  shielded: fromEvents(state.shielded.progress),
  unshielded: {
    applied: state.unshielded.progress.appliedId,
    highest: state.unshielded.progress.highestTransactionId,
    connected: state.unshielded.progress.isConnected,
  },
  dust: fromEvents(state.dust.progress),
});

/**
 * A sub-wallet has caught up: it heard from the indexer and applied at least the
 * highest index reported so far (`target`, default the current report).
 */
export const subWalletCaughtUp = (
  progress: SubWalletProgress,
  target = progress.highest,
): boolean =>
  progress.connected && progress.applied >= (progress.highest > target ? progress.highest : target);

/** Whole seconds or minutes and seconds, for public progress lines. */
export const formatDuration = (milliseconds: number): string => {
  const seconds = Math.max(0, Math.round(milliseconds / 1000));
  if (seconds < 60) return `${String(seconds)} s`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return rest === 0 ? `${String(minutes)} min` : `${String(minutes)} min ${String(rest)} s`;
};

/**
 * `shielded 1200/5000, unshielded 3/3, dust not connected (applied/highest index)`.
 * `targets` replaces each reported highest index by the highest one seen so far.
 */
export const formatSyncProgress = (
  progress: WalletSyncProgress | undefined,
  targets?: Readonly<Record<SubWallet, bigint>>,
): string => {
  if (progress === undefined) return "no wallet state yet";
  const parts = SUB_WALLETS.map((name) => {
    const item = progress[name];
    if (!item.connected) return `${name} not connected`;
    const target = targets?.[name] ?? item.highest;
    const highest = item.highest > target ? item.highest : target;
    return `${name} ${item.applied.toString()}/${highest.toString()}`;
  });
  return `${parts.join(", ")} (applied/highest index)`;
};

/** The wallet did not reach a complete sync (timeout, or its state stream ended). */
export class WalletNotSyncedError extends Error {
  constructor(
    /** Last observed position, if any state was observed. */
    readonly progress: WalletSyncProgress | undefined,
    readonly elapsedMs: number,
    readonly reason: string,
    /** Public one-line description of the position. */
    readonly detail: string = formatSyncProgress(progress),
  ) {
    super(`wallet not synced after ${formatDuration(elapsedMs)} (${reason}): ${detail}`);
    this.name = "WalletNotSyncedError";
  }
}

/** Default bound for a complete sync: 60 minutes. */
export const DEFAULT_SYNC_TIMEOUT_MS = 60 * 60 * 1000;
/** Default sampling interval: 5 s. */
export const DEFAULT_SYNC_SAMPLE_MS = 5_000;
/** Default number of consecutive caught-up samples: 3. */
export const DEFAULT_SYNC_STABLE_SAMPLES = 3;
/** Default interval between progress lines: 30 s. */
export const DEFAULT_SYNC_PROGRESS_MS = 30_000;

/** Options of {@link waitForCompleteSync}. */
export interface SyncWaitOptions {
  /** Give up after this long (default {@link DEFAULT_SYNC_TIMEOUT_MS}). */
  readonly timeoutMs?: number;
  /** Sampling interval (default {@link DEFAULT_SYNC_SAMPLE_MS}). */
  readonly sampleMs?: number;
  /** Consecutive caught-up samples required (default {@link DEFAULT_SYNC_STABLE_SAMPLES}). */
  readonly stableSamples?: number;
  /** Interval between progress lines (default {@link DEFAULT_SYNC_PROGRESS_MS}). */
  readonly progressEveryMs?: number;
  /** Receives the public progress lines. */
  readonly log?: (line: string) => void;
}

/** A completed sync. */
export interface CompleteSync<S> {
  readonly state: S;
  readonly progress: WalletSyncProgress;
  readonly elapsedMs: number;
}

const positive = (value: number | undefined, fallback: number, name: string): number => {
  const chosen = value ?? fallback;
  if (!Number.isFinite(chosen) || chosen <= 0) throw new RangeError(`${name} must be positive`);
  return chosen;
};

/**
 * Wait until every sub-wallet has caught up with the indexer and stays caught up for
 * `stableSamples` consecutive samples, printing progress every `progressEveryMs`.
 * Resolves with the last sampled state.
 *
 * @throws {WalletNotSyncedError} After `timeoutMs`, or when the state stream ends
 * first. Errors of the state stream are passed on (as `Error`s).
 */
export const waitForCompleteSync = <S extends SyncProgressSource>(
  states: Observable<S>,
  options: SyncWaitOptions = {},
): Promise<CompleteSync<S>> => {
  const timeoutMs = positive(options.timeoutMs, DEFAULT_SYNC_TIMEOUT_MS, "timeoutMs");
  const sampleMs = positive(options.sampleMs, DEFAULT_SYNC_SAMPLE_MS, "sampleMs");
  const stableSamples = Math.ceil(
    positive(options.stableSamples, DEFAULT_SYNC_STABLE_SAMPLES, "stableSamples"),
  );
  const progressEveryMs = positive(
    options.progressEveryMs,
    DEFAULT_SYNC_PROGRESS_MS,
    "progressEveryMs",
  );
  const log = options.log ?? (() => undefined);

  return new Promise<CompleteSync<S>>((resolve, reject) => {
    const started = Date.now();
    const targets: Record<SubWallet, bigint> = { shielded: 0n, unshielded: 0n, dust: 0n };
    let latest: S | undefined;
    let latestProgress: WalletSyncProgress | undefined;
    let stable = 0;
    let lastLine = started;
    let finished = false;
    // Closing it also ends a subscription added after an early (synchronous) finish.
    const subscription = new Subscription();

    const finish = (settle: () => void): void => {
      if (finished) return;
      finished = true;
      clearInterval(timer);
      subscription.unsubscribe();
      settle();
    };

    const observe = (state: S): void => {
      latest = state;
      latestProgress = syncProgressOf(state);
      for (const name of SUB_WALLETS) {
        const item = latestProgress[name];
        if (item.connected && item.highest > targets[name]) targets[name] = item.highest;
      }
    };

    const notSynced = (reason: string): WalletNotSyncedError =>
      new WalletNotSyncedError(
        latestProgress,
        Date.now() - started,
        reason,
        formatSyncProgress(latestProgress, targets),
      );

    const sample = (): void => {
      const now = Date.now();
      const elapsed = now - started;
      const progress = latestProgress;
      const caughtUp =
        progress !== undefined &&
        SUB_WALLETS.every((name) => subWalletCaughtUp(progress[name], targets[name]));
      stable = caughtUp ? stable + 1 : 0;
      if (stable >= stableSamples && latest !== undefined && progress !== undefined) {
        const state = latest;
        finish(() => resolve({ state, progress, elapsedMs: elapsed }));
        return;
      }
      if (elapsed >= timeoutMs) {
        finish(() => reject(notSynced(`timed out after ${formatDuration(timeoutMs)}`)));
        return;
      }
      if (now - lastLine >= progressEveryMs) {
        lastLine = now;
        log(
          `wallet sync        ${formatSyncProgress(progress, targets)}, elapsed ${formatDuration(elapsed)}`,
        );
      }
    };

    const timer = setInterval(sample, sampleMs);
    subscription.add(
      states.subscribe({
        next: observe,
        error: (error: unknown) =>
          finish(() => reject(error instanceof Error ? error : new Error(String(error)))),
        complete: () => finish(() => reject(notSynced("the wallet stopped before it was synced"))),
      }),
    );
  });
};
