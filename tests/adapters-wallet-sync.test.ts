/**
 * Complete wallet sync, against a fake facade state stream shaped like
 * wallet-sdk-facade 5.0.0-beta.2's `FacadeState` (the progress fields the check reads,
 * plus an `isSynced` flag that the check must ignore, plus secret-looking fields that
 * must never reach a progress line):
 * - an early `isSynced` flip while a sub-wallet still lags does not count;
 * - a caught-up moment that does not last for the required samples does not count;
 * - a stale, lower report of the indexer's highest index does not lower the target;
 * - a stalled sync times out as "not synced" with its progress;
 * - progress lines hold public counters only.
 */
import { Subject } from "rxjs";
import { describe, expect, it } from "vitest";

import {
  formatDuration,
  formatSyncProgress,
  subWalletCaughtUp,
  syncProgressOf,
  waitForCompleteSync,
  WalletNotSyncedError,
} from "../src/adapters/wallet-sync.js";

const WORDS = `${"abandon ".repeat(23)}diesel`;
const SECRET = "5ec12e7a11d0ea51c0ffee5ec12e7a11d0ea51c0ffee5ec12e7a11d0ea51c0ff";

interface Position {
  readonly applied: bigint;
  readonly highest: bigint;
  readonly connected?: boolean;
}

interface FakeFacadeState {
  readonly isSynced: boolean;
  readonly shielded: {
    readonly progress: {
      readonly appliedIndex: bigint;
      readonly highestRelevantWalletIndex: bigint;
      readonly highestIndex: bigint;
      readonly isConnected: boolean;
    };
    readonly secretKeys: string;
  };
  readonly unshielded: {
    readonly progress: {
      readonly appliedId: bigint;
      readonly highestTransactionId: bigint;
      readonly isConnected: boolean;
    };
    readonly mnemonic: string;
  };
  readonly dust: {
    readonly progress: {
      readonly appliedIndex: bigint;
      readonly highestRelevantWalletIndex: bigint;
      readonly highestIndex: bigint;
      readonly isConnected: boolean;
    };
    readonly secretKey: string;
  };
}

/** A facade state; `isSynced` defaults to true to model a flag that flipped early. */
const facadeState = (
  shielded: Position,
  unshielded: Position,
  dust: Position,
  isSynced = true,
): FakeFacadeState => ({
  isSynced,
  shielded: {
    progress: {
      appliedIndex: shielded.applied,
      highestRelevantWalletIndex: shielded.highest,
      highestIndex: 0n,
      isConnected: shielded.connected ?? true,
    },
    secretKeys: SECRET,
  },
  unshielded: {
    progress: {
      appliedId: unshielded.applied,
      highestTransactionId: unshielded.highest,
      isConnected: unshielded.connected ?? true,
    },
    mnemonic: WORDS,
  },
  dust: {
    progress: {
      appliedIndex: dust.applied,
      highestRelevantWalletIndex: dust.highest,
      highestIndex: 0n,
      isConnected: dust.connected ?? true,
    },
    secretKey: SECRET,
  },
});

const synced = (shielded: bigint, unshielded: bigint, dust: bigint): FakeFacadeState =>
  facadeState(
    { applied: shielded, highest: shielded },
    { applied: unshielded, highest: unshielded },
    { applied: dust, highest: dust },
  );

const pause = (ms: number) => new Promise((resolveWait) => setTimeout(resolveWait, ms));

const FAST = { sampleMs: 10, stableSamples: 3, progressEveryMs: 1_000_000 } as const;

describe("completeness rule", () => {
  it("reads the SDK's per-wallet counters, not the isSynced flag", () => {
    const state = facadeState(
      { applied: 5n, highest: 9n },
      { applied: 2n, highest: 2n },
      { applied: 7n, highest: 7n, connected: false },
    );
    expect(syncProgressOf(state)).toEqual({
      shielded: { applied: 5n, highest: 9n, connected: true },
      unshielded: { applied: 2n, highest: 2n, connected: true },
      dust: { applied: 7n, highest: 7n, connected: false },
    });
    const progress = syncProgressOf(state);
    expect(subWalletCaughtUp(progress.shielded)).toBe(false);
    expect(subWalletCaughtUp(progress.unshielded)).toBe(true);
    // Not connected: the indexer's highest index is not known yet.
    expect(subWalletCaughtUp(progress.dust)).toBe(false);
    // A higher target seen earlier is not lowered by a later, lower report.
    expect(subWalletCaughtUp(progress.unshielded, 3n)).toBe(false);
  });

  it("formats public counters and durations", () => {
    const progress = syncProgressOf(
      facadeState(
        { applied: 1200n, highest: 5000n },
        { applied: 3n, highest: 3n },
        { applied: 0n, highest: 0n, connected: false },
      ),
    );
    expect(formatSyncProgress(progress)).toBe(
      "shielded 1200/5000, unshielded 3/3, dust not connected (applied/highest index)",
    );
    expect(formatSyncProgress(undefined)).toBe("no wallet state yet");
    expect(formatDuration(0)).toBe("0 s");
    expect(formatDuration(59_400)).toBe("59 s");
    expect(formatDuration(90_000)).toBe("1 min 30 s");
    expect(formatDuration(3_600_000)).toBe("60 min");
  });
});

describe("waitForCompleteSync", () => {
  it("does not accept an early isSynced flip while a sub-wallet still lags", async () => {
    const states = new Subject<FakeFacadeState>();
    let settled = false;
    const waiting = waitForCompleteSync(states, { ...FAST, timeoutMs: 5_000 }).finally(() => {
      settled = true;
    });
    // The facade flag says synced, but the DUST wallet has applied 100 of 250,000 events.
    states.next(
      facadeState(
        { applied: 900n, highest: 900n },
        { applied: 4n, highest: 4n },
        { applied: 100n, highest: 250_000n },
      ),
    );
    await pause(100);
    expect(settled).toBe(false);
    states.next(
      facadeState(
        { applied: 900n, highest: 900n },
        { applied: 4n, highest: 4n },
        { applied: 180_000n, highest: 250_000n },
      ),
    );
    await pause(60);
    expect(settled).toBe(false);
    states.next(synced(900n, 4n, 250_000n));
    const result = await waiting;
    expect(result.progress.dust).toEqual({ applied: 250_000n, highest: 250_000n, connected: true });
    expect(result.state.dust.progress.appliedIndex).toBe(250_000n);
  });

  it("does not accept a caught-up moment that does not last for the required samples", async () => {
    const states = new Subject<FakeFacadeState>();
    let settled = false;
    const waiting = waitForCompleteSync(states, {
      sampleMs: 20,
      stableSamples: 4,
      progressEveryMs: 1_000_000,
      timeoutMs: 5_000,
    }).finally(() => {
      settled = true;
    });
    // At connection every counter reads 0/0: complete by the SDK's own rule.
    states.next(synced(0n, 0n, 0n));
    await pause(30);
    // Then the indexer reports how far it really is.
    states.next(
      facadeState(
        { applied: 0n, highest: 5000n },
        { applied: 0n, highest: 12n },
        { applied: 0n, highest: 90_000n },
      ),
    );
    await pause(150);
    expect(settled).toBe(false);
    states.next(synced(5000n, 12n, 90_000n));
    const result = await waiting;
    expect(result.progress.shielded.applied).toBe(5000n);
    expect(result.progress.unshielded.applied).toBe(12n);
    // Four consecutive samples after the catch-up at >= 180 ms (small timer slack).
    expect(result.elapsedMs).toBeGreaterThanOrEqual(180 + 60 - 10);
  });

  it("keeps the highest target seen when a later report is lower (stale indexer)", async () => {
    const states = new Subject<FakeFacadeState>();
    let settled = false;
    const waiting = waitForCompleteSync(states, { ...FAST, timeoutMs: 5_000 }).finally(() => {
      settled = true;
    });
    states.next(
      facadeState(
        { applied: 200n, highest: 500n },
        { applied: 1n, highest: 1n },
        { applied: 10n, highest: 10n },
      ),
    );
    await pause(20);
    // A reconnect to a lagging indexer reports 150: applied 200 >= 150, still not done.
    states.next(
      facadeState(
        { applied: 200n, highest: 150n },
        { applied: 1n, highest: 1n },
        { applied: 10n, highest: 10n },
      ),
    );
    await pause(100);
    expect(settled).toBe(false);
    states.next(synced(500n, 1n, 10n));
    await expect(waiting).resolves.toMatchObject({
      progress: { shielded: { applied: 500n, highest: 500n } },
    });
  });

  it("times out as not synced when the sync stalls, with the last progress", async () => {
    const states = new Subject<FakeFacadeState>();
    const waiting = waitForCompleteSync(states, { ...FAST, timeoutMs: 120 });
    states.next(
      facadeState(
        { applied: 1200n, highest: 5000n },
        { applied: 3n, highest: 3n },
        { applied: 40_000n, highest: 250_000n },
      ),
    );
    const error = await waiting.then(
      () => undefined,
      (failure: unknown) => failure,
    );
    expect(error).toBeInstanceOf(WalletNotSyncedError);
    const notSynced = error as WalletNotSyncedError;
    expect(notSynced.progress?.dust).toEqual({
      applied: 40_000n,
      highest: 250_000n,
      connected: true,
    });
    expect(notSynced.elapsedMs).toBeGreaterThanOrEqual(120);
    expect(notSynced.detail).toBe(
      "shielded 1200/5000, unshielded 3/3, dust 40000/250000 (applied/highest index)",
    );
    expect(notSynced.message).toMatch(/^wallet not synced after \d+ s \(timed out after 0 s\): /);
    expect(states.observed).toBe(false);
  });

  it("times out as not synced when the wallet never reports any state", async () => {
    const states = new Subject<FakeFacadeState>();
    const error = await waitForCompleteSync(states, { ...FAST, timeoutMs: 50 }).then(
      () => undefined,
      (failure: unknown) => failure,
    );
    expect(error).toBeInstanceOf(WalletNotSyncedError);
    expect((error as WalletNotSyncedError).progress).toBeUndefined();
    expect((error as Error).message).toContain("no wallet state yet");
  });

  it("fails as not synced when the state stream ends first, and passes stream errors on", async () => {
    const ended = new Subject<FakeFacadeState>();
    const endedWait = waitForCompleteSync(ended, { ...FAST, timeoutMs: 5_000 });
    ended.next(synced(1n, 1n, 1n));
    ended.complete();
    await expect(endedWait).rejects.toThrow(/the wallet stopped before it was synced/);

    const failing = new Subject<FakeFacadeState>();
    const failingWait = waitForCompleteSync(failing, { ...FAST, timeoutMs: 5_000 });
    failing.error(new Error("indexer connection refused"));
    await expect(failingWait).rejects.toThrow("indexer connection refused");
  });

  it("prints periodic progress lines that hold public counters only", async () => {
    const states = new Subject<FakeFacadeState>();
    const lines: string[] = [];
    const waiting = waitForCompleteSync(states, {
      sampleMs: 10,
      stableSamples: 2,
      progressEveryMs: 25,
      timeoutMs: 400,
      log: (line) => lines.push(line),
    });
    states.next(
      facadeState(
        { applied: 10n, highest: 5000n },
        { applied: 0n, highest: 0n, connected: false },
        { applied: 100n, highest: 250_000n },
      ),
    );
    const error = await waiting.then(
      () => undefined,
      (failure: unknown) => failure,
    );
    expect(error).toBeInstanceOf(WalletNotSyncedError);
    expect(lines.length).toBeGreaterThanOrEqual(3);
    const everything = [...lines, (error as Error).message].join("\n");
    for (const line of lines) {
      expect(line).toMatch(
        /^wallet sync {8}shielded 10\/5000, unshielded not connected, dust 100\/250000 \(applied\/highest index\), elapsed \d+ s$/,
      );
    }
    expect(everything).not.toContain(SECRET);
    expect(everything).not.toContain("abandon");
    expect(everything).not.toContain("diesel");
  });

  it("refuses non-positive settings", () => {
    const states = new Subject<FakeFacadeState>();
    expect(() => waitForCompleteSync(states, { timeoutMs: 0 })).toThrow(RangeError);
    expect(() => waitForCompleteSync(states, { stableSamples: -1 })).toThrow(RangeError);
  });
});
