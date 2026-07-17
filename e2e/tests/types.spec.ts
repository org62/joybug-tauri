import { test, expect } from "../helpers/test-fixtures";
import { createAndStartSession, cleanupSession, invoke, goToWindow } from "../helpers/session-helpers";
import {
  waitForPaused,
  configureMinimalStopSettings,
  restoreDefaultSettings,
} from "../helpers/wait-helpers";

// Minimal shapes of the type-system DTOs we assert on.
interface TypeRef {
  name: string;
  size: number;
  class: { kind: string; index?: number };
}
interface TypeMember {
  name: string;
  offset: number;
  type_ref: TypeRef;
  bit_length: number | null;
}
interface TypeLayout {
  name: string;
  size: number;
  kind: string;
  index: number;
  module_base: string;
  members: TypeMember[];
  source: string;
}
interface CustomTypeDef {
  id: string;
  name: string;
  fields: { name: string; type_expr: string; offset: number | null }[];
  is_union: boolean;
}

test.describe("Type System", () => {
  test("reads PDB struct layouts from ntdll and overlays live values", async ({
    tauriPage: page,
  }) => {
    // Cold ntdll PDB download can be slow.
    test.setTimeout(120_000);
    await configureMinimalStopSettings(page);

    try {
      const sessionId = await createAndStartSession(page, "Type System");
      await waitForPaused(page, sessionId);

      // Types come from ntdll's PDB; wait until _KUSER_SHARED_DATA resolves
      // (implies ntdll symbols + type stream are parsed).
      let kuser: TypeLayout | null = null;
      await expect(async () => {
        kuser = (await invoke(page, "get_session_type", {
          sessionId,
          name: "_KUSER_SHARED_DATA",
          moduleBase: null,
        })) as TypeLayout | null;
        expect(kuser?.members?.length ?? 0).toBeGreaterThan(10);
      }).toPass({ timeout: 90_000, intervals: [500, 1000] });

      // _KUSER_SHARED_DATA is a fixed-size struct with a known NtSystemRoot member.
      expect(kuser!.kind).toBe("struct");
      expect(kuser!.size).toBe(1848);
      expect(kuser!.members.some((m) => m.name === "NtSystemRoot")).toBeTruthy();

      // _PEB: BeingDebugged is an unsigned char at offset 2, and no member should
      // render as an opaque "t#NN" (primitive + function-pointer resolution).
      const peb = (await invoke(page, "get_session_type", {
        sessionId,
        name: "_PEB",
        moduleBase: null,
      })) as TypeLayout;
      const beingDebugged = peb.members.find((m) => m.name === "BeingDebugged");
      expect(beingDebugged).toBeTruthy();
      expect(beingDebugged!.offset).toBe(2);
      expect(beingDebugged!.type_ref.name).toContain("char");
      expect(peb.members.some((m) => m.bit_length != null)).toBeTruthy(); // bitfields
      expect(peb.members.some((m) => /^t#\d+/.test(m.type_ref.name))).toBeFalsy();

      // list_session_types with a filter surfaces the struct.
      const listed = (await invoke(page, "list_session_types", {
        sessionId,
        moduleBase: null,
        filter: "_KUSER_SHARED_DATA",
        maxResults: 50,
      })) as { name: string }[];
      expect(listed.some((t) => t.name === "_KUSER_SHARED_DATA")).toBeTruthy();

      // Nested expansion by index: find a UDT member and resolve it.
      const udtMember = peb.members.find(
        (m) => m.type_ref.class.kind === "udt" && (m.type_ref.class.index ?? 0) > 0,
      );
      if (udtMember) {
        const nested = (await invoke(page, "get_session_type_by_index", {
          sessionId,
          moduleBase: peb.module_base,
          index: udtMember.type_ref.class.index,
        })) as TypeLayout | null;
        expect(nested).toBeTruthy();
      }

      // TEB/PEB anchors resolve, and memory reads at those anchors succeed.
      const tebPeb = (await invoke(page, "get_session_teb_peb", { sessionId })) as {
        teb: string | null;
        peb: string | null;
      };
      expect(tebPeb.peb).toBeTruthy();
      const kuserBytes = (await invoke(page, "read_memory_sync", {
        sessionId,
        address: "0x7FFE0000",
        size: 64,
      })) as number[];
      expect(kuserBytes.length).toBe(64);

      // UI smoke: open the Types tab and overlay KUSER via the quick button.
      // Not in the default layout, so ask for it rather than clicking a tab header.
      await goToWindow(page, "Types");
      await page.getByRole("button", { name: "KUSER" }).first().click();
      await expect(page.getByText("NtSystemRoot", { exact: false }).first()).toBeVisible({
        timeout: 15_000,
      });

      // Changed-value highlighting: a step triggers the pause refresh, which
      // re-reads the overlay; KUSER_SHARED_DATA time fields always advance
      // between two reads, so some member values must get the shared
      // `data-changed` marker (`data-member-value` scopes to the types view).
      await invoke(page, "step_in_debug_session", { sessionId });
      await waitForPaused(page, sessionId);
      await expect(async () => {
        const changedCount = await page.locator("span[data-member-value][data-changed]").count();
        expect(changedCount).toBeGreaterThan(0);
      }).toPass({ timeout: 10_000, intervals: [100, 250] });

      await cleanupSession(page, sessionId);
    } finally {
      await restoreDefaultSettings(page);
    }
  });

  test("builds, resolves, and deletes a user-defined type", async ({
    tauriPage: page,
  }) => {
    test.setTimeout(60_000);
    await configureMinimalStopSettings(page);

    let savedId: string | null = null;
    try {
      const sessionId = await createAndStartSession(page, "Custom Types");
      await waitForPaused(page, sessionId);

      // Parse a C-like struct declaration.
      const parsed = (await invoke(page, "parse_custom_type_text", {
        text: "struct E2EType { unsigned long Flags; void* Next; wchar_t Name[16]; };",
      })) as CustomTypeDef;
      expect(parsed.name).toBe("E2EType");
      expect(parsed.fields.map((f) => f.name)).toEqual(["Flags", "Next", "Name"]);
      expect(parsed.fields[1].type_expr).toContain("*");
      expect(parsed.fields[2].type_expr).toContain("[16]");

      // Save it (backend assigns an id).
      const saved = (await invoke(page, "save_custom_type", { def: parsed })) as CustomTypeDef;
      expect(saved.id).toBeTruthy();
      savedId = saved.id;

      // It appears in the list.
      const list = (await invoke(page, "list_custom_types", {})) as CustomTypeDef[];
      expect(list.some((c) => c.id === savedId)).toBeTruthy();

      // Resolve it into a layout with computed, sequential offsets:
      // Flags@0 (4B), Next@8 (pointer-aligned), Name@16 (wchar_t[16] = 32B) → size 48.
      const layout = (await invoke(page, "resolve_custom_type", {
        sessionId,
        id: savedId,
      })) as TypeLayout;
      expect(layout.source).toBe("custom");
      expect(layout.members.map((m) => m.offset)).toEqual([0, 8, 16]);
      expect(layout.members[1].type_ref.class.kind).toBe("pointer");
      expect(layout.members[2].type_ref.class.kind).toBe("array");
      expect(layout.size).toBe(48);

      // Delete it.
      await invoke(page, "delete_custom_type", { id: savedId });
      const after = (await invoke(page, "list_custom_types", {})) as CustomTypeDef[];
      expect(after.some((c) => c.id === savedId)).toBeFalsy();
      savedId = null;

      await cleanupSession(page, sessionId);
    } finally {
      if (savedId) await invoke(page, "delete_custom_type", { id: savedId }).catch(() => {});
      await restoreDefaultSettings(page);
    }
  });
});
