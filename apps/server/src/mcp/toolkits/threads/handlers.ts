import * as Effect from "effect/Effect";

import * as ThreadMetadataMcp from "../../ThreadMetadataMcpService.ts";
import * as ThreadsTools from "./tools.ts";

const make = Effect.gen(function* () {
  const metadata = yield* ThreadMetadataMcp.ThreadMetadataMcpService;
  return ThreadsTools.ThreadsToolkit.of({ t3_thread_update: metadata.update });
});

export const ThreadsToolkitHandlersLive = ThreadsTools.ThreadsToolkit.toLayer(make);
