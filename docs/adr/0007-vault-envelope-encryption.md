# ADR 0007: Card data isolated in a vault with envelope encryption

**Status:** accepted

## Context
Under PCI DSS, every system that stores, processes or transmits card numbers is in scope. Spreading PANs across services multiplies the audit surface and the blast radius of a breach.

## Decision
Only the vault service sees PANs. Browsers send card details straight to the vault (publishable key), so merchants never touch them. Each PAN is encrypted with its own random 256-bit data key (AES-256-GCM); the data key is wrapped by a versioned key-encryption key held outside the database. The record id is bound in as AAD, so a ciphertext copied to another row fails to decrypt. A keyed HMAC fingerprint lets risk rules count per-card velocity without decrypting. CVC is validated and discarded. The payment service gets the PAN only through an internal, audited `reveal` endpoint.

## Consequences
+ Small PCI scope; KEK rotation re-wraps 32-byte keys instead of re-encrypting all card data.
+ Tampering is detected (GCM tag), and fingerprints can't be reversed without the HMAC key.
− In production the KEKs belong in an HSM or KMS, and inter-service auth should be mTLS (this demo uses environment keys and a shared token).
