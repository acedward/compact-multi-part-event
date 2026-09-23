/**
 * A minimal in-process ledger for the offline demo: a blank ledger-v9 state, one block
 * per applied transaction, and the composer's state source over it. Transactions are
 * applied with proofs erased and fee balancing relaxed (there is no wallet here), so
 * this checks construction, placement and events, not proofs or fees.
 */
import * as ledger from "@midnightntwrk/ledger-v9";
import type { PinnedBlock, PublicationStateSource } from "compact-multi-segment-emit/transaction";

type AnyTransaction = ledger.Transaction<ledger.Signaturish, ledger.Proofish, ledger.Bindingish>;

export class LocalLedger {
  state: ledger.LedgerState;
  time: Date;
  height = 1;
  blockHash = "ab".repeat(32);

  constructor(
    readonly network: string,
    start = new Date("2026-09-23T00:00:00Z"),
  ) {
    this.state = ledger.LedgerState.blank(network);
    this.time = new Date(Math.floor(start.getTime() / 1000) * 1000);
  }

  get seconds(): number {
    return Math.floor(this.time.getTime() / 1000);
  }

  /** Apply one transaction (proofs erased) in a new block. */
  apply(tx: AnyTransaction): ledger.TransactionResult {
    const strictness = new ledger.WellFormedStrictness();
    strictness.enforceBalancing = false;
    strictness.verifyContractProofs = false;
    strictness.verifySignatures = false;
    strictness.verifyNativeProofs = true;
    strictness.enforceLimits = true;
    const verified = tx.eraseProofs().wellFormed(this.state, strictness, this.time);
    const secondsSinceEpoch = BigInt(this.seconds);
    const [next, result] = this.state.apply(
      verified,
      new ledger.TransactionContext(this.state, {
        secondsSinceEpoch,
        secondsSinceEpochErr: 0,
        parentBlockHash: this.blockHash,
        lastBlockTime: secondsSinceEpoch - 6n,
      }),
    );
    this.time = new Date(this.time.getTime() + 6000);
    this.state = next.postBlockUpdate(this.time);
    this.height += 1;
    this.blockHash = this.height.toString(16).padStart(64, "0");
    return result;
  }

  /** The composer's state source: the latest block, then the state at that block. */
  source(): PublicationStateSource {
    return {
      latestBlock: (): Promise<PinnedBlock> =>
        Promise.resolve({
          hash: this.blockHash,
          height: this.height,
          timestampSeconds: this.seconds,
        }),
      contractStateAt: (address, blockHash) => {
        const contractState = this.state.index(address);
        if (blockHash !== this.blockHash || contractState === undefined) {
          return Promise.reject(new Error(`no contract ${address} at ${blockHash}`));
        }
        return Promise.resolve({ contractState, ledgerParameters: this.state.parameters });
      },
    };
  }
}
