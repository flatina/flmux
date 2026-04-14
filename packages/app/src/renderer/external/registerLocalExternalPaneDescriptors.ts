import type { PaneDescriptor } from "../shell/paneRegistry";
import { cowsayPaneDescriptor } from "./cowsayDescriptor";
import { inspectorPaneDescriptor } from "./inspectorDescriptor";
import { scratchpadPaneDescriptor } from "./scratchpadDescriptor";

export interface LocalExternalPaneRegistrationHost {
  registerExternalPane(descriptor: PaneDescriptor): void;
}

const LOCAL_EXTERNAL_PANE_DESCRIPTORS: readonly PaneDescriptor[] = [
  cowsayPaneDescriptor,
  inspectorPaneDescriptor,
  scratchpadPaneDescriptor
];

export function registerLocalExternalPaneDescriptors(host: LocalExternalPaneRegistrationHost) {
  for (const descriptor of LOCAL_EXTERNAL_PANE_DESCRIPTORS) {
    host.registerExternalPane(descriptor);
  }
}
