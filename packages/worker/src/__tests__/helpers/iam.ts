import { type Authenticator, fakeAuthenticator } from '../../iam'

/**
 * A dev authenticator that authorizes EVERY action — a global-admin default persona, selected without
 * an `X-Dev-Principal` header. Lets data-path tests drive `handleApi` without modelling the ACL (that
 * is covered by the auth tests). Mirrors the old allow-all `new FakeIamClient()`.
 */
export function allowAllIam(): Authenticator {
	return fakeAuthenticator({
		personas: { 'admin@test': { id: 'mem-admin', label: 'admin@test', type: 'user', permissions: [{ action: '*', scope: null, source: 'grant' }] } },
		defaultEmail: 'admin@test',
	})
}
