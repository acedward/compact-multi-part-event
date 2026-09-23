/**
 * Chain services for the CLI commands over the in-process ledger and the fake indexer:
 * stand-in prover (no proofs), stand-in wallet (binds, pays no fee), a submitter that
 * applies the submitted transaction (proofs erased) and indexes the submitted bytes.
 */
import type * as ledger from "@midnightntwrk/ledger-v9";

import type { ChainServices, IncludedTransaction } from "../../src/cli/commands.js";
import type { PublicationBalancer, PublicationProver } from "../../src/transaction/index.js";
import { COIN_PUBLIC_KEY } from "./generated.js";
import type { FakeIndexer } from "./fake-indexer.js";
import { NETWORK } from "./ledger.js";

type Proven = ledger.Transaction<ledger.SignatureEnabled, ledger.Proof, ledger.PreBinding>;

export const standInProver: PublicationProver = {
  proveTx: (tx) => Promise.resolve(tx as unknown as Proven),
};

export const standInBalancer: PublicationBalancer = {
  balanceTx: (tx) =>
    Promise.resolve(
      (
        tx as unknown as ledger.UnprovenTransaction
      ).bind() as unknown as ledger.FinalizedTransaction,
    ),
};

export interface OfflineServices {
  readonly services: ChainServices;
  readonly lines: string[];
  readonly submitted: ledger.FinalizedTransaction[];
}

export const offlineServices = (
  fake: FakeIndexer,
  overrides: Partial<ChainServices> = {},
): OfflineServices => {
  const { chain } = fake;
  const lines: string[] = [];
  const submitted: ledger.FinalizedTransaction[] = [];
  const services: ChainServices = {
    network: NETWORK,
    stateSource: chain.source(),
    currentParameters: () =>
      Promise.resolve({
        block: {
          hash: chain.parentBlockHash,
          height: chain.height,
          timestampSeconds: chain.seconds,
        },
        ledgerParameters: chain.state.parameters,
      }),
    prover: standInProver,
    balancer: standInBalancer,
    submitter: {
      submitTx: (tx) => {
        submitted.push(tx);
        fake.include(tx, { applied: tx.eraseProofs() });
        return Promise.resolve(tx.identifiers()[0] ?? "");
      },
    },
    coinPublicKey: COIN_PUBLIC_KEY,
    waitForInclusion: (identifiers) => {
      const entry = fake.entries.find((item) =>
        identifiers.some((identifier) => item.identifiers.includes(identifier)),
      );
      const included: IncludedTransaction | undefined =
        entry === undefined
          ? undefined
          : {
              hash: entry.hash,
              rawHex: entry.rawHex,
              status: entry.status,
              identifiers: entry.identifiers,
              blockHeight: entry.blockHeight,
              blockHash: entry.blockHash,
            };
      return Promise.resolve(included);
    },
    contractState: (address) => Promise.resolve(chain.state.index(address)?.serialize()),
    proofTimeoutMs: 1000,
    requireProofs: false,
    log: (line) => lines.push(line),
    ...overrides,
  };
  return { services, lines, submitted };
};
