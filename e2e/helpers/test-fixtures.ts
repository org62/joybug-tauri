// The specs' one import for the test runner surface: `test`, `expect`, the
// page type, and the navigation helpers. Behind it: Mocha + WebdriverIO on the
// app's real webview (see pw.ts / test.ts / lifecycle.ts).

export { test, expect } from "./test";
export type { Fixtures, TestInfo } from "./test";
export type { Page, Locator } from "./pw";
export { navigateTo, gotoFreshPe } from "./lifecycle";
export { APP_ORIGIN } from "./app";
