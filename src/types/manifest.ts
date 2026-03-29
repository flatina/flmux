export interface ExtensionCommandSpec {
  id: string;
  description?: string;
}

export interface ExtensionManifest {
  id: string;
  name: string;
  version: string;
  apiVersion: number;
  setupEntry?: string;
  rendererEntry?: string;
  cliEntry?: string;
  commands?: ExtensionCommandSpec[];
  permissions?: string[];
}
