# Code signing

Released builds are currently **ad-hoc signed**, which works but triggers a first-launch warning on macOS (Gatekeeper) and Windows (SmartScreen). To remove those warnings you need a certificate from a trusted authority — a self-signed certificate does **not** help, because the OS only trusts certificates tied to a verified identity.

## macOS (Apple notarization)

Requires an [Apple Developer Program](https://developer.apple.com/programs/) membership ($99/yr).

1. Create a **Developer ID Application** certificate in your Apple developer account and install it in your login keychain.
2. Create an app-specific password for notarization.
3. Build with these environment variables set; electron-builder signs and notarizes automatically:

```bash
export CSC_LINK=/path/to/DeveloperID.p12      # or rely on the keychain
export CSC_KEY_PASSWORD=...                    # p12 password
export APPLE_ID=you@example.com
export APPLE_APP_SPECIFIC_PASSWORD=xxxx-xxxx-xxxx-xxxx
export APPLE_TEAM_ID=XXXXXXXXXX
npm run dist:mac
```

## Windows

Pick one:

- **SignPath (free for open source):** https://signpath.io — issues a certificate and signs your artifacts for OSS projects at no cost. The recommended option for this project.
- **Azure Trusted Signing:** ~$10/month, gives immediate SmartScreen trust.
- **A bought OV/EV certificate** from a CA (DigiCert, Sectigo, …).

With a certificate file, electron-builder signs automatically when these are set:

```bash
export CSC_LINK=/path/to/codesign.pfx
export CSC_KEY_PASSWORD=...
npm run dist:win
```

For EV certificates on a hardware token, or for SignPath, follow that provider's CI signing flow instead (they sign the artifact after the build).

## CI

The cleanest setup is to sign in CI (GitHub Actions) using repository secrets for the variables above, so local machines never hold the certificates. electron-builder reads the same `CSC_*` / `APPLE_*` variables in CI.
