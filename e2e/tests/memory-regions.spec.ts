import { test, expect } from "../helpers/test-fixtures";
import {
  createAndStartSession,
  cleanupSession,
  invoke,
  goToWindow,
  moduleBase,
} from "../helpers/session-helpers";
import {
  waitForPaused,
  waitForDisassemblyLoaded,
  configureMinimalStopSettings,
  restoreDefaultSettings,
  getPcAddress,
} from "../helpers/wait-helpers";
import {
  installEventCapture,
  waitForCapturedEvent,
} from "../helpers/event-helpers";
import { PC_ROW } from "../helpers/selectors";
import type { Page } from "@playwright/test";

interface RegionAnnotation {
  kind: string;
  label: string;
  address?: string;
}

interface RegionData {
  base_address: string;
  region_size: number;
  state: string;
  region_type: string;
  annotations: RegionAnnotation[];
}

const REGIONS_EVENT = "memory-regions-updated";
const REGION_ROW = '[data-testid="memory-region-row"]';
const HIGHLIGHTED_ROW = `${REGION_ROW}[data-highlighted]`;

/** Fetch the annotated region list via the backend event. */
async function fetchRegions(page: Page, sessionId: string): Promise<RegionData[]> {
  await installEventCapture(page, [REGIONS_EVENT]);
  await invoke(page, "request_memory_regions", { sessionId });
  const res = await waitForCapturedEvent(
    page,
    REGIONS_EVENT,
    (p) => p.session_id === sessionId && (p.regions?.length ?? 0) > 0,
    15_000,
  );
  return res.regions as RegionData[];
}

function containingRegion(regions: RegionData[], address: bigint): RegionData | undefined {
  return regions.find((r) => {
    const base = BigInt(r.base_address);
    return base <= address && address < base + BigInt(r.region_size);
  });
}

test.describe("Memory Regions", () => {
  test("regions carry module/section/peb/heap/teb/stack annotations", async ({
    tauriPage: page,
  }) => {
    test.setTimeout(60_000);
    await configureMinimalStopSettings(page);

    try {
      const sessionId = await createAndStartSession(page, "Region Annotations");
      await waitForPaused(page, sessionId);

      const regions = await fetchRegions(page, sessionId);
      for (const r of regions) {
        expect(Array.isArray(r.annotations)).toBe(true);
      }

      // ntdll is loaded by the initial breakpoint; its MEM_IMAGE regions must be
      // labeled with the module name and include a .text section badge.
      const ntdllRegions = regions.filter((r) =>
        r.annotations.some((a) => a.kind === "module" && /ntdll\.dll/i.test(a.label)),
      );
      expect(ntdllRegions.length).toBeGreaterThan(0);
      expect(
        ntdllRegions.some((r) =>
          r.annotations.some((a) => a.kind === "section" && a.label === ".text"),
        ),
      ).toBe(true);

      // Process-structure annotations all appear at least once.
      const all = regions.flatMap((r) => r.annotations);
      for (const kind of ["peb", "teb", "stack", "heap"]) {
        expect(all.some((a) => a.kind === kind), `missing kind ${kind}`).toBe(true);
      }
      const teb = all.find((a) => a.kind === "teb")!;
      expect(teb.label).toMatch(/^TEB \(tid \d+\)$/);
      expect(all.some((a) => a.kind === "heap" && /default/.test(a.label))).toBe(true);

      // Typed-structure annotations carry the exact structure address so the
      // UI can link their badges to the Types view.
      for (const kind of ["teb", "peb", "kuser"]) {
        const a = all.find((x) => x.kind === kind);
        if (a) expect(a.address, `missing address on ${kind}`).toMatch(/^0x[0-9A-F]{16}$/);
      }

      await cleanupSession(page, sessionId);
    } finally {
      await restoreDefaultSettings(page);
    }
  });

  test("goto scrolls to and highlights the containing region, resetting filters", async ({
    tauriPage: page,
  }) => {
    test.setTimeout(60_000);
    await configureMinimalStopSettings(page);

    try {
      const sessionId = await createAndStartSession(page, "Region Goto");
      await waitForPaused(page, sessionId);

      const regions = await fetchRegions(page, sessionId);
      const base = await moduleBase(page, sessionId, "ntdll");
      expect(base).toBeTruthy();
      const target = BigInt(base!) + 0x1000n;
      const expected = containingRegion(regions, target);
      expect(expected).toBeTruthy();

      await goToWindow(page, "Memory Regions");
      const panel = page.locator('[data-testid="memory-regions-panel"]');
      await expect(panel.locator(REGION_ROW).first()).toBeVisible({ timeout: 10_000 });

      // End Address column: header present, first visible row shows base + size.
      await expect(panel.getByText("End Address")).toBeVisible();
      const firstRow = panel.locator(REGION_ROW).first();
      const firstBase = (await firstRow.getAttribute("data-base"))!;
      const firstRegion = regions.find((r) => r.base_address === firstBase)!;
      const expectedEnd = `0x${(BigInt(firstBase) + BigInt(firstRegion.region_size))
        .toString(16)
        .toUpperCase()
        .padStart(16, "0")}`;
      await expect(firstRow).toContainText(expectedEnd);

      // Hide MEM_IMAGE regions via the Type filter, then goto an image address —
      // the view must auto-widen the filters to reveal the hit.
      await panel.getByRole("combobox").nth(1).click();
      await page.getByRole("option", { name: "Mapped" }).click();

      const gotoInput = panel.getByPlaceholder(/Address/);
      await gotoInput.fill(`0x${target.toString(16)}`);
      await gotoInput.press("Enter");

      await expect(async () => {
        const row = panel.locator(HIGHLIGHTED_ROW);
        expect(await row.count()).toBe(1);
        expect(await row.getAttribute("data-base")).toBe(expected!.base_address);
      }).toPass({ timeout: 5_000, intervals: [50, 100] });

      // Filters were reset so the image region is visible.
      await expect(panel.getByRole("combobox").nth(1)).toHaveText(/All Types/);

      // Badge click: a TEB badge opens the Types view at that TEB's address.
      const tebRegion = regions.find((r) =>
        r.annotations.some((a) => a.kind === "teb" && a.address),
      )!;
      expect(tebRegion).toBeTruthy();
      const tebAnn = tebRegion.annotations.find((a) => a.kind === "teb" && a.address)!;
      await gotoInput.fill(tebRegion.base_address);
      await gotoInput.press("Enter");
      const tebRow = panel.locator(`${REGION_ROW}[data-base="${tebRegion.base_address}"]`);
      await expect(tebRow).toBeVisible({ timeout: 5_000 });
      await tebRow.getByText(/^TEB \(tid \d+\)$/).first().click();
      await expect(
        page.locator(".dock-tab", { hasText: /^Types$/ }).first(),
      ).toBeVisible({ timeout: 10_000 });
      // The Types overlay address input received the TEB address.
      await expect
        .poll(
          () =>
            page.locator("input").evaluateAll((els) =>
              (els as HTMLInputElement[]).map((e) => e.value),
            ),
          { timeout: 10_000, intervals: [100, 250] },
        )
        .toContain(tebAnn.address);

      await cleanupSession(page, sessionId);
    } finally {
      await restoreDefaultSettings(page);
    }
  });

  test("context menus in disassembly and memory navigate to the region", async ({
    tauriPage: page,
  }) => {
    test.setTimeout(60_000);
    await configureMinimalStopSettings(page);

    try {
      const sessionId = await createAndStartSession(page, "Region Context Menus");
      await waitForPaused(page, sessionId);

      const regions = await fetchRegions(page, sessionId);
      const pc = await getPcAddress(page, sessionId);
      expect(pc).toBeTruthy();
      const pcRegion = containingRegion(regions, BigInt(pc!));
      expect(pcRegion).toBeTruthy();

      // Disassembly row → Go to Memory Region highlights the PC's region.
      await goToWindow(page, "Disassembly");
      await waitForDisassemblyLoaded(page);
      await page.locator(PC_ROW).first().click({ button: "right" });
      await page.getByRole("menuitem", { name: "Go to Memory Region" }).click();

      const panel = page.locator('[data-testid="memory-regions-panel"]');
      await expect(async () => {
        const row = panel.locator(HIGHLIGHTED_ROW);
        expect(await row.count()).toBe(1);
        expect(await row.getAttribute("data-base")).toBe(pcRegion!.base_address);
      }).toPass({ timeout: 10_000, intervals: [50, 100] });

      // Row click opens the region in the memory view at its base address.
      await panel
        .locator(`${REGION_ROW}[data-base="${pcRegion!.base_address}"]`)
        .click();
      const hexPanel = page.locator('[data-testid="hex-panel"]');
      const firstByte = hexPanel.locator("span.cursor-pointer").first();
      await expect(firstByte).toBeVisible({ timeout: 10_000 });

      // Select a byte, then Go to Memory Region highlights the same region.
      await firstByte.click();
      await firstByte.click({ button: "right" });
      await page.getByRole("menuitem", { name: "Go to Memory Region" }).click();

      await expect(async () => {
        const row = panel.locator(HIGHLIGHTED_ROW);
        expect(await row.count()).toBe(1);
        expect(await row.getAttribute("data-base")).toBe(pcRegion!.base_address);
      }).toPass({ timeout: 10_000, intervals: [50, 100] });

      await cleanupSession(page, sessionId);
    } finally {
      await restoreDefaultSettings(page);
    }
  });
});
