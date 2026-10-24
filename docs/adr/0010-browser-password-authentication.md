# Browser password authentication with durable internal keys

Status: accepted for issue #82.

## Context

Sig has one owner per deployment. Requiring the owner to call an API for a short-lived login link makes initial setup and access from another device unnecessarily difficult. Password sign-in must work through the public deployment URL without exposing the internal signing key. An attacker must not be able to exhaust the password budget and thereby disable every way the owner can use Sig.

The previous design uses `SERVER_KEY` both for owner API authorization and for signing machine credentials and sealing model settings. Replacing it with a user-selected password would couple password recovery to machine pairing and data decryption.

## Decision

The deployment form accepts `LOGIN_PASSWORD`. The root URL opens the workspace or a shared login page with password and passkey controls. The first authenticated session continues through model setup and optional passkey registration. Another device uses the same URL and either credential.

The owner Durable Object is the authority for authentication and persistent attempt budgets. New deployments generate and retain their internal keys inside that object. The Worker does not obtain those keys through a public method. Existing deployments retain explicit `SERVER_KEY` and `SERVER_KEY_PREVIOUS` semantics, including the owner API. The generated key is never an owner API bearer credential.

`LOGIN_PASSWORD` remains a Cloudflare Secret controlled by the deployment owner. Sig stores a salted password verifier and reconciles configuration changes. It does not derive internal signing or encryption keys from the password. Password reset invalidates browser sessions, their WebSockets, and outstanding login links without changing machine credentials, model encryption keys, or registered passkeys.

Password policy requires at least 15 characters, supports password managers, and rejects common and compromised passwords. Screening uses a bounded hash-prefix query rather than sending the password or full hash. Failed screening keeps password setup closed while preserving other established authentication methods. The deployment owner must publish the new Worker version when changing the Secret. Mixing versions with different password configuration through gradual rollout is unsupported.

Edge source-IP limits reject abusive requests before expensive work. Durable admission limits password attempts across IP addresses and edge locations. Counters survive object eviction and reserve capacity before asynchronous verification. Password cooldowns and passkey traffic use separate budgets. Throttling bounds guessing and resource use, but a sustained distributed attack can temporarily deny password access; it does not permanently lock the entire owner account.

The shipped thresholds are:

| Scope | Limit | Window / recovery |
|---|---|---|
| Edge, per route scope and source IP | 10 requests | 60 seconds; Cloudflare's edge counter is not a global budget |
| Password, per source IP | 5 attempts | 60-second fixed window, reserved before verification |
| Password, deployment-wide | 20 attempts | 60-second fixed window, reserved before verification |
| Password failures, per source IP | 5 failures | 30 seconds, doubling per additional failure to a 15-minute cap; a successful sign-in or password reset clears it |
| Passkey verify, per source IP | 20 attempts | 60-second fixed window, reserved before signature verification |
| Passkey verify, deployment-wide | 100 attempts | 60-second fixed window, reserved before signature verification |

`429` responses include `Retry-After`. Password throttling does not block passkeys, existing sessions, or dashboard recovery. Passkey options have their own edge scope; they do not consume password or passkey-verification budgets.

## Consequences

- Public entry points share one authentication policy. Direct access to Agents routes cannot bypass it.
- Passkey management requires recent authentication. Ordinary workspace activity remains available in an older valid session.
- Existing explicit-key deployments can upgrade without replacing keys or re-pairing machines. They can roll back to an older build while retaining their explicit secrets.
- Generated-key deployments require a compatible build and preservation of their Durable Object storage. Their encryption keys and ciphertext are stored in the same security boundary, so database compromise has a different impact than it does with an external `SERVER_KEY`.
- Cloudflare retains the configured password Secret. The salted application verifier is not a claim that the Secret has been deleted from Cloudflare.
- Cloudflare Access, OAuth, and private networking remain independent deployment choices. None is required for the default browser flow.

This supersedes the browser-entry portions of ADR-0003, ADR-0005, and ADR-0007. The optional explicit-key owner API and machine pairing protocol remain supported.
