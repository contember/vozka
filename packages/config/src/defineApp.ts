import type { AppConfig } from './types'

/**
 * Authoring entry point for a vozka app. Identity function: it returns the config unchanged so
 * the call site keeps full inference, while pinning the type and doing the minimal runtime
 * validation that must hold for ANY downstream step (the `id` is the control plane's primary key).
 *
 * The rest of the config is validated lazily by the deploy engine (M1), not here — `defineApp`
 * is meant to be cheap and importable from anywhere (CLI, worker, tests).
 */
export const defineApp = (config: AppConfig): AppConfig => {
	if (typeof config.id !== 'string' || config.id.trim() === '') {
		throw new Error('defineApp: `id` is required and must be a non-empty string')
	}
	return config
}
