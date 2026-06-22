#!/usr/bin/env bun
/**
 * Run Buzola's codegen via Bun so the page-metadata extractor can actually `import()` our .tsx
 * route files (the shipped `bunx buzola` CLI uses Node and fails to load TSX). Mirrors the
 * propustka admin-ui gen step.
 */
import { generate } from '@buzola/codegen'
import path from 'node:path'

const root = path.resolve(import.meta.dir, '..')
await generate({
	routesDir: path.join(root, 'src/routes'),
	outputPath: path.join(root, 'src/buzola.gen.ts'),
})
