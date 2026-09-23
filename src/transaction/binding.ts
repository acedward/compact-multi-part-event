/**
 * The typed binding the composer uses to execute the emission circuit of any
 * contract that imports `MultiSegmentEmit`. The composer never imports a generated
 * `Contract` class; the integrator passes its own generated contract through
 * {@link bindingFromContract} (or implements {@link EmissionBinding} directly).
 *
 * @module
 */
import type { CircuitContext, CircuitResults } from "@midnight-ntwrk/compact-runtime";

/** Signature of a generated emission circuit: `(context, requestId, payload)`. */
export type EmitPartCircuit<PS> = (
  context: CircuitContext<PS>,
  requestId: Uint8Array,
  payload: Uint8Array,
) => Promise<CircuitResults<PS, []>>;

/** What the composer needs to execute one part of a publication. */
export interface EmissionBinding<PS> {
  /** Name of the emission circuit (the contract operation's entry point). */
  readonly entryPoint: string;
  /** Executes the emission circuit for one part. */
  readonly emitPart: EmitPartCircuit<PS>;
  /**
   * Fresh private state for one part execution (it answers the access-control
   * witness, e.g. `emitterSecret` or `messageOwnerSecret`). Called once per part.
   */
  readonly createPrivateState: () => PS;
}

/** The structural part of a generated contract instance the binding uses. */
export interface ContractWithEmission<PS, E extends string> {
  readonly impureCircuits: { readonly [K in E]: EmitPartCircuit<PS> };
}

/**
 * Build a binding from a generated contract instance (`new Contract(witnesses)`).
 *
 * @param contract - Any generated contract whose impure circuits include `entryPoint`.
 * @param entryPoint - Name of its emission circuit.
 * @param createPrivateState - Private state factory for each part execution.
 */
export const bindingFromContract = <PS, E extends string>(
  contract: ContractWithEmission<PS, E>,
  entryPoint: E,
  createPrivateState: () => PS,
): EmissionBinding<PS> => ({
  entryPoint,
  emitPart: (context, requestId, payload) =>
    contract.impureCircuits[entryPoint](context, requestId, payload),
  createPrivateState,
});
