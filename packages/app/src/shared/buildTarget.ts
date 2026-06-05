// Substituted by `bun build --define __FLMUX_COMPILED__=true`; absent in dev.
declare const __FLMUX_COMPILED__: boolean;

export const isCompiledBinary: boolean = typeof __FLMUX_COMPILED__ !== "undefined" && __FLMUX_COMPILED__ === true;
