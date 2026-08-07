# Security Policy

## Supported versions

Security fixes are applied to the latest `main` branch and the latest published
desktop release.

## Reporting a vulnerability

Please open a private GitHub security advisory for `fanchen000/grok-desktop`.
Do not include access tokens, cookies, private keys, Grok authentication files,
private conversation content or proprietary source code in a public issue.

## Security boundaries

- Grok credentials remain owned by the separately installed official Grok CLI.
- The renderer never receives or parses Grok authentication files.
- Browser control is restricted to the app's registered internal browser view.
- Privileged desktop actions are authorized in the Electron main process.
- Local ACP, MCP and compatibility services bind to loopback interfaces.
- Account switching changes the child-process home environment rather than
  copying credential contents.

The project does not claim affiliation with or endorsement by xAI, OpenAI or
the upstream OpenChamber project.
