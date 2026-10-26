# Vendored Qishui login packages

The `qishui-api` and `qishui-core` package archives in this directory are built directly from:

`D:\SKILL\qishui-api-master\qishui-api-master`

Upstream project: `Yinxe/qishui-api` - https://github.com/Yinxe/qishui-api. Both package manifests declare MIT.

WaveMusic uses these immutable package snapshots for the complete Qishui device registration, QR login, cookie persistence, account validation, and multi-account session flow. Integration-specific Electron code lives outside these packages and only adapts the source project's `QishuiLogin` object to the desktop login UI.
