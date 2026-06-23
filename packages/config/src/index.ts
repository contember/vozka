// vozka-config — the single app-authoring surface. An app imports ONLY from here: it gets
// `defineApp` + its config types, every oblaka resource primitive (Worker, D1Database,
// KVNamespace, R2Bucket, Queue, DurableObject, Container, ServiceReference, define, …), and the
// propustka edge/authz declaration types — so a `vozka.config.ts` never imports `oblaka-iac` or
// `@propustka/core` directly.

export { defineApp } from './defineApp'
export type { AppConfig, AppPipeline, ResourceContext } from './types'

// Re-export oblaka's resource primitives so apps author their resource graph from this package.
export * from 'oblaka-iac'

// Re-export the propustka declaration types apps need to author `access` / `schema`.
export type { AccessAppDecl, AccessRule, AppAccess, AppActionDef, AppSchema, AppScopeDef, RoleDef } from '@propustka/core'
