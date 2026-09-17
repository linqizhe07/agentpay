#!/usr/bin/env node
// Runs the TypeScript CLI directly via tsx (the monorepo has no build step).
import { register } from 'tsx/esm/api';

register();
await import('../src/cli.ts');
