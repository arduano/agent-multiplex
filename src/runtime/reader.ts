import { RuntimeError } from "./validation.js";
import {
  type NativeOpening,
  type OpeningCapsule,
  type OpeningStopProof,
  type ReaderCustodyPort,
} from "./contracts.js";
import { openingProof } from "./proofs.js";

/** Explicit cleanup of one journalled auxiliary resource, never a scan, native
 * conversation attachment, or inference from a missing in-memory reader. */
export async function retireReader(
  custody: ReaderCustodyPort | undefined,
  inspect: (capsule: OpeningCapsule) => Promise<NativeOpening | OpeningStopProof | null>,
): Promise<void> {
  if (!custody) return;
  const held = await custody.read();
  if (held.state === "none") return;
  if (held.state !== "owned")
    throw new RuntimeError("BUSY", "Reader allocation custody remains unconfirmed");
  const found = await inspect(held.capsule);
  if (!found) throw new RuntimeError("BUSY", "Exact reader custody is unavailable");
  const proof = openingProof(held.capsule, "state" in found ? found : await found.stop());
  await custody.released(proof);
}
