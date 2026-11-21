import { expect, type Page } from "./test-fixtures";
import { ASM_PANEL, ASM_ROW_ONLY } from "./selectors";

const POLL = { timeout: 10_000, intervals: [50, 100] };

/** Read only the instruction viewport, not the surrounding dock scroll area. */
export async function assemblyViewport(page: Page) {
  const state = await page.evaluate(({ panel, row }) => {
    const vp = Array.from(document.querySelectorAll<HTMLDivElement>(
      `${panel} [data-slot="scroll-area-viewport"]`,
    )).find((el) => el.clientHeight > 0 && el.querySelector(row));
    if (!vp) return null;
    const bounds = vp.getBoundingClientRect();
    const rows = Array.from(vp.querySelectorAll<HTMLElement>(row)).flatMap((el) => {
      const rect = el.getBoundingClientRect();
      return el.dataset.address && rect.bottom > bounds.top && rect.top < bounds.bottom
        && rect.right > bounds.left && rect.left < bounds.right
        ? [{ address: el.dataset.address, highlight: el.dataset.highlight, height: rect.height }]
        : [];
    });
    return { rows, top: vp.scrollTop, height: vp.clientHeight, extent: vp.scrollHeight,
      x: bounds.left + bounds.width / 2, y: bounds.top + bounds.height / 2 };
  }, { panel: ASM_PANEL, row: ASM_ROW_ONLY });
  return state && { ...state, rows: state.rows.map((row) => ({ ...row, address: BigInt(row.address) })) };
}

export async function expectAssemblyContext(page: Page, address: bigint, {
  highlight, predecessor, after = address,
}: { highlight?: "selected" | "pc"; predecessor?: bigint; after?: bigint } = {}) {
  await expect(async () => {
    const rows = (await assemblyViewport(page))?.rows ?? [];
    expect(rows.some((row) => row.address === address && (!highlight || row.highlight === highlight)),
      `anchor 0x${address.toString(16)} intersects the viewport`).toBe(true);
    expect(rows.some((row) => predecessor === undefined ? row.address < address : row.address === predecessor),
      "earlier instruction intersects the viewport").toBe(true);
    expect(rows.some((row) => row.address > after), "later instruction intersects the viewport").toBe(true);
  }).toPass(POLL);
}

export async function refreshUnderPointer(page: Page) {
  const refresh = page.locator(`${ASM_PANEL} button[title="Refresh"]`);
  await expect(refresh).toBeVisible();
  const box = await refresh.boundingBox();
  expect(box).toBeTruthy();
  await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);
  await refresh.click();
  await expect(refresh).toBeEnabled(POLL);
}

/** Leave the pointer exactly where refreshUnderPointer put it. Use VAs of
 * intersecting rows to prove motion, even when a prepend changes scrollTop. */
export async function expectAssemblyWheel(page: Page, direction: -1 | 1) {
  const firstVisible = async () => (await assemblyViewport(page))?.rows[0]?.address;
  for (const sign of [1, -1]) {
    const before = (await firstVisible())!;
    await page.mouse.wheel(0, sign * 72);
    await expect(async () => {
      const after = await firstVisible();
      expect(after !== undefined && (sign > 0 ? after > before : after < before)).toBe(true);
    }).toPass(POLL);
  }

  const initial = (await assemblyViewport(page))!;
  const rowHeight = initial.rows[0].height;
  let pulses = 0;
  await expect(async () => {
    if (++pulses <= 24) await page.mouse.wheel(0, direction * Math.floor(initial.height * 0.8));
    const state = await assemblyViewport(page);
    // Only one direction is being extended. Require the viewport to cross
    // the original content boundary by more than one row, not just grow.
    const crossed = state && state.extent > initial.extent && (direction < 0
      ? state.top + rowHeight < state.extent - initial.extent
      : state.top + state.height > initial.extent + rowHeight);
    expect(crossed && state.rows.some((row) => direction < 0
      ? row.address < initial.rows[0].address
      : row.address > initial.rows.at(-1)!.address), "wheel exposed instructions beyond the initial range").toBe(true);
  }).toPass(POLL);

  const before = (await firstVisible())!;
  await page.mouse.wheel(0, direction * 72);
  await expect(async () => {
    const after = await firstVisible();
    expect(after !== undefined && (direction < 0 ? after < before : after > before),
      "wheel still moves the listing after an extension").toBe(true);
  }).toPass(POLL);
}
