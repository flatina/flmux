import {
  PtydClient as CorePtydClient,
  type PtydClientOptions,
  type PtydLaunchPlan
} from "@flmux/core/terminal/ptyd/client";
import type { PtydTerminalEvent } from "@flmux/core/terminal/ptyd/controlPlane";
import { createAppPtydLaunchPlan } from "./launch";

export type { PtydClientOptions, PtydLaunchPlan };

export class PtydClient extends CorePtydClient {
  constructor(
    rootKey: string,
    rootDir: string,
    onEventOrOptions?: ((event: PtydTerminalEvent) => void) | PtydClientOptions
  ) {
    const options = typeof onEventOrOptions === "function" ? { onEvent: onEventOrOptions } : (onEventOrOptions ?? {});
    super(rootKey, rootDir, {
      ...options,
      launch: options.launch ?? createAppPtydLaunchPlan
    });
  }
}
