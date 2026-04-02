import type { PropertyHandle } from "../types/property";

export type ColorTheme = "system" | "dark" | "light";

export class AppScope {
  constructor(private readonly props: PropertyHandle) {}

  get title(): string { return this.props.get("title") as string; }
  set title(value: string) { this.props.set("title", value); }

  get colorTheme(): ColorTheme { return (this.props.get("colorTheme") as ColorTheme) ?? "dark"; }
  set colorTheme(value: ColorTheme) { this.props.set("colorTheme", value); }
}
