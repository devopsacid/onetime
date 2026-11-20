# Security policy

## Reporting a vulnerability

Please report privately, not in a public issue.

1. Primary: GitHub private vulnerability reporting. Open the repository's Security tab and choose "Report a vulnerability" (https://github.com/devopsacid/onetime/security/advisories/new).
2. E-mail: Contact: <to be filled by the main session>

Include what you found, how to reproduce it and which commit or deployment you tested. This is a one-person project: expect a first answer within a few days, not hours. Please give a reasonable time to fix before publishing. Do not test with other people's secrets, and do not run load tests against the live site.

## Scope

In scope: this repository and its deployment at https://onetimepass.pages.dev, in particular

- anything that lets the server, a third party or a link preview see plaintext or the key, or read a secret without the link;
- a link that works more than once, or a secret that survives its reveal or expiry;
- GET requests that burn a secret;
- weaknesses in the browser or CLI crypto, the CSP, or the self-host server (`server/`);
- the CLI release (`dist/cli/onetime.mjs`) and its provenance attestation.

## Out of scope

- No per-IP rate limit. This is a known open point (see `docs/plans/security-hardening.md`), as is the global cap of 20,000 stored secrets that an attacker can fill (HTTP 503). Reports about it alone will be closed as known.
- Denial of service by volume, spam, and social engineering.
- Compromise of the sender's or recipient's device or browser, or of the channel the link was sent through: whoever holds the full link can open it once.
- Third-party services (Cloudflare, GitHub, Google Analytics on the info pages) and self-hosted instances run by others.
- Findings that need a modified or outdated browser, or Windows and macOS CLI behaviour not described in the README.

## Honest status

This project has not had an independent security audit. The code is MIT-licensed and open for review, but nobody has been paid or asked to certify it. Do not rely on it for secrets whose loss would be severe.
