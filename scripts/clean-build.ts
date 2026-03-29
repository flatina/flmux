#!/usr/bin/env bun
import { rmSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
rmSync(resolve(root, "build"), { recursive: true, force: true });
console.log("Cleaned build/");
