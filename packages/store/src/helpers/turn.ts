import type { StoreOps, TurnLoad, TurnLoadRequest } from "@vendoai/core";

/** A turn's opening reads as the calls they bundle, over whichever `StoreOps`
 *  is asked. Two implementations answer with exactly this: the local backend,
 *  whose reads are these ops and which has nothing to add to them, and the
 *  hosted client on a mount below `STORE_WIRE_TURN_OPS`, where it IS the cheaper
 *  fallback the pre-send check routes to. Composed rather than reimplemented so
 *  the envelope cannot drift from the ops it bundles. */
export async function turnLoadOverOps(ops: StoreOps, request: TurnLoadRequest): Promise<TurnLoad> {
  return {
    thread: await ops.transcripts.getThread(request.thread.id),
    index: await ops.workspace.index(request.index),
    // Asked for or absent — never a null standing in for an answer nobody wanted.
    ...(request.read ? { read: await ops.workspace.read(request.read.paths, request.read) } : {}),
    ...(request.harness ? { harness: await ops.harness.get(request.harness.appId, request.harness.subject) } : {}),
    ...(request.usage ? { usage: await ops.usage!.count(request.usage) } : {}),
  };
}
