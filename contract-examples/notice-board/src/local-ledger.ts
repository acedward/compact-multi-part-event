/**
 * A minimal in-process ledger for the offline demo: a blank ledger-v9 state, one block
 * per applied transaction, a plain `ContractDeploy`, and the publisher's state source
 * over it. Transactions are applied with proofs erased and fee balancing relaxed (there
 * is no wallet here), so this checks construction, placement and events, not proofs or
 * fees.
 */
import * as ledger from "@midnightntwrk/ledger-v9";
import type { PinnedBlock, PublicationStateSource } from "compact-multi-segment-emit/publisher";

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

  /**
   * Deploy a contract state with the given verifier keys installed (no maintenance
   * authority: this ledger is local). Returns the address.
   *
   * @throws {Error} If the deployment does not apply.
   */
  deploy(
    initialState: { serialize(): Uint8Array },
    verifierKeys: Readonly<Record<string, Uint8Array>>,
  ): string {
    const state = ledger.ContractState.deserialize(initialState.serialize());
    for (const [circuit, key] of Object.entries(verifierKeys)) {
      const operation = state.operation(circuit);
      if (operation === undefined) throw new Error(`no operation '${circuit}'`);
      operation.verifierKey = key;
      state.setOperation(circuit, operation);
    }
    const deploy = new ledger.ContractDeploy(state);
    const tx = ledger.Transaction.fromParts(
      this.network,
      undefined,
      undefined,
      ledger.Intent.new(new Date(this.time.getTime() + 10 * 60 * 1000)).addDeploy(deploy),
    );
    const result = this.apply(tx);
    if (result.type !== "success") throw new Error(`deploy failed: ${String(result.error)}`);
    return deploy.address;
  }

  /** The publisher's state source: the latest block, then the state at that block. */
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
