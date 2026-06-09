// `${appName|appVersion|host}` substitution for app.toml display strings —
// fixed key allow-list, not eval. Unknown tokens pass through.
export interface AppTemplateVars {
  appName: string;
  appVersion: string;
  /** location.host in the watermark; "" in the title. */
  host: string;
}

const TEMPLATE_KEYS: ReadonlyArray<keyof AppTemplateVars> = ["appName", "appVersion", "host"];

export function renderAppTemplate(template: string, vars: AppTemplateVars): string {
  return template.replace(/\$\{(\w+)\}/g, (match, key: string) =>
    (TEMPLATE_KEYS as readonly string[]).includes(key) ? vars[key as keyof AppTemplateVars] : match
  );
}
