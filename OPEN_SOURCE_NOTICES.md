# Open Source Notices

## OpenChamber

Grok Code Desktop uses the mature desktop interface and application shell from
OpenChamber.

- Upstream project: `openchamber/openchamber`
- Upstream license: MIT
- Local source tree: this repository

The Grok integration layer in this local fork connects the interface to the
official Grok Build Agent Client Protocol (ACP) process installed on this
computer. It does not bundle or redistribute Grok credentials.

The upstream MIT license and copyright notice remain in `LICENSE`. This project
retains internal OpenChamber-compatible package and protocol identifiers where
renaming them would break interoperability; user-visible branding is Grok
Desktop / Grok Code.

## Grok Build

Grok Desktop launches the separately installed official Grok Build executable
through ACP and official CLI commands. The Grok executable, service, models,
account, subscription and trademarks are provided by xAI and are not included
in this repository.

This project never bundles, copies or publishes Grok credentials. Account
profiles only select isolated home directories for the official Grok process.
