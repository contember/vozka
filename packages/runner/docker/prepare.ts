#!/usr/bin/env bun
// Stage the runner image's build context.
//
// vozka's deploy toolchain isn't published yet, and the `oblaka-iac` on npm predates the
// programmatic `deploy()` the M1 engine calls — so the repo uses an `oblaka-iac: file:../oblaka`
// override. The image can't reach that sibling path from its build context (the vozka repo root),
// so we vendor a freshly-packed oblaka tarball into `docker/vendor/` and point the image's
// package.json at it. Run by `bun run docker:build` before `docker build`.

import { resolve } from 'node:path'

const here = import.meta.dir
const repoRoot = resolve(here, '../../..')
const oblakaDir = resolve(repoRoot, '../oblaka')
const vendorDir = resolve(here, 'vendor')
const tarballPath = resolve(vendorDir, 'oblaka-iac.tgz')

// Pack the local oblaka into the vendor dir as a stable filename.
const pack = Bun.spawn(['bun', 'pm', 'pack', '--destination', vendorDir], { cwd: oblakaDir, stdout: 'pipe', stderr: 'pipe' })
const packExit = await pack.exited
const packOut = await new Response(pack.stdout).text()
if (packExit !== 0) {
	console.error(await new Response(pack.stderr).text())
	process.exit(packExit)
}

// `bun pm pack` names the tgz `<name>-<version>.tgz`; normalize to a version-independent name so
// the image's package.json can reference a stable path.
const produced = packOut.match(/oblaka-iac-[\d.]+\.tgz/)?.[0]
if (produced === undefined) {
	console.error('could not determine packed oblaka tarball name from:\n', packOut)
	process.exit(1)
}
await Bun.write(tarballPath, Bun.file(resolve(vendorDir, produced)))

console.info(`vendored ${produced} → docker/vendor/oblaka-iac.tgz`)
