import { test, expect, navigateTo, gotoFreshPe } from "../helpers/test-fixtures";

// A dependency-free 64-bit system DLL that always exists on the test host.
const NTDLL = "C:\\Windows\\System32\\ntdll.dll";

test.describe("PE Viewer", () => {
  test("empty page shows the placeholder", async ({ tauriPage: page }) => {
    // gotoFreshPe forces a full load so the placeholder is asserted against a
    // genuine fresh start, not a PE another test opened and left cached.
    await gotoFreshPe(page);
    await expect(page.getByText("No PE file open").first()).toBeVisible({
      timeout: 10_000,
    });
  });

  test("nav shows PE Viewer", async ({ tauriPage: page }) => {
    await navigateTo(page, "/");
    await expect(page.getByText("PE Viewer", { exact: true }).first()).toBeVisible({
      timeout: 5_000,
    });
  });

  test("deep-link opens a 64-bit PE and renders the structure tree + tabs", async ({
    tauriPage: page,
  }) => {
    await navigateTo(page, "/pe?path=" + encodeURIComponent(NTDLL));

    // Foldable structure tree — top-level nodes.
    await expect(page.getByText("DOS Header", { exact: true }).first()).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText("NT Headers", { exact: true }).first()).toBeVisible();
    await expect(page.getByText("Sections", { exact: false }).first()).toBeVisible();
    await expect(page.getByText("Imports", { exact: false }).first()).toBeVisible();

    // Dock tabs and the loaded file name.
    await expect(page.getByText("Symbols", { exact: true }).first()).toBeVisible();
    await expect(page.getByText("Strings", { exact: true }).first()).toBeVisible();
    await expect(page.getByText("Disassembly", { exact: true }).first()).toBeVisible();
    await expect(page.getByText("ntdll.dll", { exact: false }).first()).toBeVisible();
  });

  test("hex goto accepts a pasted VA and loads bytes at its file offset", async ({
    tauriPage: page,
  }) => {
    await navigateTo(page, "/pe?path=" + encodeURIComponent(NTDLL));
    await expect(page.getByText("DOS Header", { exact: true }).first()).toBeVisible({ timeout: 15_000 });

    // The hex view is file-offset addressed; a VA (>= the 0x180000000 image
    // base of system DLLs) must be translated through the section mappings
    // instead of being read as an offset past EOF ("No memory loaded").
    const gotoInput = page.getByPlaceholder("Address or symbol...").last();
    await gotoInput.fill("0x180001000");
    await gotoInput.press("Enter");
    await expect(page.getByText(/0x180001000/i).first()).toBeVisible({ timeout: 5_000 });
    await expect(page.getByText("No memory loaded")).not.toBeVisible();
  });

  test("rejects a 32-bit PE with a clear message", async ({
    tauriPage: page,
  }) => {
    await navigateTo(page, "/pe");
    // Unlike the shared invoke() helper, the error must be stringified inside
    // the page: the backend rejects with a plain object, which Playwright's
    // evaluate bridge would flatten to "page.evaluate: Object".
    const err = await page.evaluate(async (path) => {
      try {
        await (window as any).__TAURI_INTERNALS__.invoke("pe_open", { path });
        return "";
      } catch (e) {
        return typeof e === "string" ? e : JSON.stringify(e);
      }
    }, "C:\\Windows\\SysWOW64\\ntdll.dll");
    expect(err).toMatch(/64-bit|x64|machine/i);
  });
});
