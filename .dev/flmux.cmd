@rem Dev-only CLI wrapper. Production builds bundle the CLI separately.
@echo off
bun "%~dp0..\src\flmux\cli\index.ts" %*
