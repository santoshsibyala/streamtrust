# Changelog

## 0.4.0

- Added `streamtrust init nextchat` and `--preset nextchat`. A local provider and Playwright exercise a separate MIT-licensed NextChat checkout at `1d3dc331512929a4b1d3e82354e72acce33b5c7a`.
- Four scenarios check persistence across reload, stopping a partial reply, regenerating an answer and retrying after a provider disconnect. The adapter reads NextChat's browser-local saved history.
- Added the NextChat setup and CI guide, a packed-package integration workflow, and npm discovery keywords.
