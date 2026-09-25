/**
 * The typed binding the publisher uses to execute an adopter's emitting circuit. The
 * publisher never imports a generated `Contract` class; the adopter passes its own
 * generated contract through {@link bindingFromContract} (or implements
 * {@link EmissionBinding} directly).
 *
 * @module
 */
import type { CircuitContext, CircuitResults } from "@midnight-ntwrk/compact-runtime";

/** What the publisher needs to execute one part of a package. */
export interface EmissionBinding<PS> {
  /** Name of the emitting circuit (the contract operation's entry point). */
  readonly entryPoint: string;
  /**
   * Executes the emitting circuit for one part: `emitPart(payload: Bytes<256>): []`,
   * which checks the adopter's access control and emits exactly one `Misc` event with
   * the adopter's name N and the payload, writing no ledger state.
   */
  emitPart(context: CircuitContext<PS>, payload: Uint8Array): Promise<CircuitResults<PS, []>>;
  /**
   * Fresh private state for one execution (it answers the access-control witness, e.g.
   * `emitterSecret`). Called once per part.
   */
  createPrivateState(): PS;
}

/** A generated emitting circuit: `(context, payload)`. */
export type EmitPartCircuit<PS> = (
  context: CircuitContext<PS>,
  payload: Uint8Array,
) => Promise<CircuitResults<PS, []>>;

/** The structural part of a generated contract instance the binding uses. */
export interface ContractWithEmission<PS, E extends string> {
  readonly impureCircuits: { readonly [K in E]: EmitPartCircuit<PS> };
}

/**
 * Build a binding from a generated contract instance (`new Contract(witnesses)`).
 *
 * @param contract - Any generated contract whose impure circuits include `entryPoint`.
 * @param entryPoint - Name of its emitting circuit.
 * @param createPrivateState - Private state factory for each part execution.
 */
export const bindingFromContract = <PS, E extends string>(
  contract: ContractWithEmission<PS, E>,
  entryPoint: E,
  createPrivateState: () => PS,
): EmissionBinding<PS> => ({
  entryPoint,
  emitPart: (context, payload) => contract.impureCircuits[entryPoint](context, payload),
  createPrivateState,
});
