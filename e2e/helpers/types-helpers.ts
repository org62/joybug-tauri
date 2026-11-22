import type { TypeLayout } from "../../src/lib/typeSystem";
import { expect, type Page } from "./test-fixtures";
import { goToWindow, invoke, type ModuleData } from "./session-helpers";
import { waitForModuleSymbols } from "./wait-helpers";

interface NtBlockOverlay {
  address: string | null;
  layout: TypeLayout | null;
}

export async function expectNtBlockShortcuts(
  page: Page,
  sessionId: string,
  ntdll: ModuleData,
  image: ModuleData,
  width: 4 | 8,
): Promise<void> {
  await waitForModuleSymbols(page, sessionId, ntdll.path, { timeout: 90_000 });
  await goToWindow(page, "Types");
  const button = (name: string) => page.getByRole("button", { name, exact: true });
  const panel = page.locator('[data-slot="dock-panel"]', { has: button("TEB") });
  const waitForOverlay = async (kind: "teb" | "peb"): Promise<NtBlockOverlay> => {
    let overlay: NtBlockOverlay | undefined;
    await expect(async () => {
      overlay = await invoke(page, "get_session_nt_block_overlay", { sessionId, kind });
      expect(overlay?.layout).toBeTruthy();
    }).toPass({ timeout: 5_000, intervals: [50, 100] });
    return overlay!;
  };
  const teb = await waitForOverlay("teb");
  const peb = await waitForOverlay("peb");

  const check = async (
    label: string,
    overlay: NtBlockOverlay,
    field: string,
    offset: number,
    expectedValue: string,
  ) => {
    expect(overlay.address).toMatch(/^0x[0-9a-f]+$/i);
    expect(overlay.layout?.name).toBe(`_${label}`);
    const layout = overlay.layout!;
    expect(BigInt(layout.module_base)).toBe(BigInt(ntdll.base_address));
    const member = layout.members.find((m) => m.name === field);
    expect(member?.offset).toBe(offset);
    expect(member?.type_ref.size).toBe(width);
    expect(member?.type_ref.class.kind).toBe("pointer");

    await button(label).click();
    await expect(panel.getByText(layout.name, { exact: true })).toBeVisible();
    await expect(panel.getByPlaceholder(/^Type name/)).toHaveValue(layout.name);
    await expect(panel.getByPlaceholder(/^Address/)).toHaveValue(overlay.address!);
    const marker = panel.getByText(field, { exact: true });
    await expect(async () => {
      const row = await marker.evaluate((el) => ({
        offset: el.previousElementSibling?.textContent,
        value: el.parentElement?.querySelector("[data-member-value]")?.textContent,
      }));
      expect(row.offset).toBe(`+0x${offset.toString(16)}`);
      expect(row.value).toMatch(/^0x[0-9a-f]+$/i);
      expect(BigInt(row.value!)).toBe(BigInt(expectedValue));
    }).toPass({ timeout: 10_000, intervals: [50, 100] });
  };

  expect(peb.address).toMatch(/^0x[0-9a-f]+$/i);
  await check("TEB", teb, "ProcessEnvironmentBlock", width === 4 ? 0x30 : 0x60, peb.address!);
  await check("PEB", peb, "ImageBaseAddress", width === 4 ? 0x08 : 0x10, image.base_address);
}
