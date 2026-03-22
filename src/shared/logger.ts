import type { LogLevel } from "./config";

const LEVEL_VALUE: Record<LogLevel, number> = { error: 0, warn: 1, info: 2, debug: 3 };

let currentLevel: number = LEVEL_VALUE.info;

export function setLogLevel(level: LogLevel): void {
  currentLevel = LEVEL_VALUE[level];
}

export function error(scope: string, message: string): void {
  if (currentLevel >= LEVEL_VALUE.error) console.error(`[flmux][${scope}] ${message}`);
}

export function warn(scope: string, message: string): void {
  if (currentLevel >= LEVEL_VALUE.warn) console.warn(`[flmux][${scope}] ${message}`);
}

export function info(scope: string, message: string): void {
  if (currentLevel >= LEVEL_VALUE.info) console.log(`[flmux][${scope}] ${message}`);
}

export function debug(scope: string, message: string): void {
  if (currentLevel >= LEVEL_VALUE.debug) console.log(`[flmux][${scope}] ${message}`);
}

/** @deprecated Use info() instead */
export const log = info;
