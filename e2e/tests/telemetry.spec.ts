import http from "http";
import type { AddressInfo } from "net";
import { test, expect } from "../helpers/test-fixtures";
import { createAndStartSession, cleanupSession, invoke } from "../helpers/session-helpers";
import { waitForPaused, waitForDisassemblyLoaded, configureMinimalStopSettings, getPcAddress } from "../helpers/wait-helpers";
import { ASM_PANEL } from "../helpers/selectors";
import { IS_WINDOWS, SYSTEM_MODULE_FILE } from "../helpers/launch-commands";

/**
 * Opt-in performance telemetry, against a collector double: a local HTTP
 * server standing in for `joybug-tauri --telemetry-collect`. The app is pointed
 * at it through the same settings a user would change.
 */

interface Collector {
  address: string;
  /** Every line of every batch received so far, in arrival order. */
  lines: () => any[];
  batches: () => any[];
  close: () => Promise<void>;
}

async function startCollector(): Promise<Collector> {
  const batches: any[] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      if (req.method === "POST" && req.url === "/v1/records") {
        batches.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
        res.statusCode = 204;
      } else {
        res.statusCode = 404;
      }
      res.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    address: `127.0.0.1:${port}`,
    lines: () => batches.flatMap((b) => b.lines),
    batches: () => batches,
    close: () => new Promise((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }),
  };
}

/** Every string anywhere in `value`. */
function strings(value: unknown, out: string[] = []): string[] {
  if (typeof value === "string") out.push(value);
  else if (Array.isArray(value)) value.forEach((v) => strings(v, out));
  else if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) {
      out.push(k);
      strings(v, out);
    }
  }
  return out;
}

const spansNamed = (lines: any[], name: string) => lines.filter((l) => l.kind === "span" && l.n === name);

test.describe("Telemetry", () => {
  test("is off by default and an address alone sends nothing", async ({ tauriPage: page }) => {
    const collector = await startCollector();
    try {
      const fresh = await invoke(page, "get_debug_settings");
      expect(fresh.telemetry_enabled).toBe(false);
      expect(fresh.telemetry_endpoint).toBe("");
      expect(fresh.telemetry_record_to_file).toBe(false);
      expect((await invoke(page, "telemetry_status")).active).toBe(false);

      await configureMinimalStopSettings(page, { telemetry_endpoint: collector.address });
      const status = await invoke(page, "telemetry_status");
      expect(status.active).toBe(false);
      expect(status.url).toBeNull();

      // A whole session with the switch off: nothing is recorded, so there is
      // nothing the worker could send however long we waited.
      const sessionId = await createAndStartSession(page, "Telemetry Off");
      try {
        await waitForPaused(page, sessionId);
        await waitForDisassemblyLoaded(page, ASM_PANEL);
      } finally {
        await cleanupSession(page, sessionId);
      }
      expect((await invoke(page, "telemetry_status")).sent_batches).toBe(status.sent_batches);
      expect(collector.batches()).toHaveLength(0);
    } finally {
      await collector.close();
    }
  });

  test("reports where a pause and a step spend their time, without naming the target", async ({ tauriPage: page }) => {
    const collector = await startCollector();
    try {
      await configureMinimalStopSettings(page, { telemetry_enabled: true, telemetry_endpoint: collector.address });
      const status = await invoke(page, "telemetry_status");
      expect(status.active).toBe(true);
      expect(status.url).toBe(`http://${collector.address}/v1/records`);

      const sessionId = await createAndStartSession(page, "Telemetry On");
      try {
        await waitForPaused(page, sessionId);
        await waitForDisassemblyLoaded(page, ASM_PANEL);

        // A step through the UI, so the frontend's own measurement is taken.
        const before = await getPcAddress(page, sessionId);
        await page.locator('button[title^="Step In"]').click();
        await expect(async () => {
          const s = await invoke(page, "get_debug_session", { sessionId });
          expect(s?.status).toBe("Paused");
          expect(s?.current_event?.address).not.toBe(before);
        }).toPass({ timeout: 15_000, intervals: [50, 100] });

        // The worker flushes every 2 s and the frontend every second: poll
        // until every layer has reported.
        await expect(async () => {
          const lines = collector.lines();
          for (const name of ["app.command", "app.debug_event", "app.disasm.function", "client.request", "server.request", "disasm.decode_listing", "ui.step"]) {
            expect(spansNamed(lines, name).length, name).toBeGreaterThan(0);
          }
          // The view's listing loads carry their reason in the name (`ui.asm.load.<reason>`).
          expect(lines.some((l) => l.kind === "span" && l.n.startsWith("ui.asm.load.")), "ui.asm.load.*").toBe(true);
        }).toPass({ timeout: 20_000, intervals: [100, 250] });

        const lines = collector.lines();

        // The listing request is followed across the layers by its name.
        const listing = spansNamed(lines, "app.command").find((s) => s.req === "DisassembleFunction");
        expect(listing, "the function listing as a queued command").toBeTruthy();
        expect(listing.a.queue_us).toBeGreaterThanOrEqual(0);
        expect(spansNamed(lines, "client.request").some((s) => s.req === "DisassembleFunction")).toBe(true);
        expect(spansNamed(lines, "server.request").some((s) => s.req === "DisassembleFunction")).toBe(true);
        const decode = spansNamed(lines, "disasm.decode_listing")[0];
        for (const key of ["read_us", "decode_us", "symbolize_us", "resolver_calls", "instructions"]) {
          expect(decode.a, key).toHaveProperty(key);
        }

        // The step: issued -> pause event -> committed -> painted, in order.
        const step = spansNamed(lines, "ui.step")[0];
        expect(step.a.viewed).toBe(1);
        expect(step.d).toBeGreaterThanOrEqual(step.a.event_us);
        expect(spansNamed(lines, "app.target_run").length).toBeGreaterThan(0);

        // The run and its session, described once.
        const run = collector.batches()[0].run;
        expect(run.run).toMatch(/^[0-9a-f]{32}$/);
        expect(run.os).toBe(IS_WINDOWS ? "windows" : "linux");
        const sessions = lines.filter((l) => l.kind === "session");
        expect(sessions).toHaveLength(1);
        expect(sessions[0].mode).toBe("local");
        expect(sessions[0].s).not.toBe(sessionId);
        expect(lines.some((l) => l.kind === "settings")).toBe(true);

        // Modules: system ones by file name, anything else as a code.
        const modules = lines.filter((l) => l.kind === "module");
        expect(modules.some((m) => m.system && SYSTEM_MODULE_FILE.test(m.name))).toBe(true);
        for (const m of modules) {
          if (!m.system) expect(m.name).toMatch(/^m-[0-9a-f]{12}$/);
        }
        if (!IS_WINDOWS) {
          // The debuggee itself is not a system module.
          expect(modules.some((m) => !m.system)).toBe(true);
        }

        // Nothing that could identify the target: no path, no address, no
        // symbol, not the session's id, not the fixture's name.
        const text = strings(collector.batches());
        for (const s of text) {
          expect(s, "a path separator").not.toMatch(/[\\/]/);
          expect(s, "an address").not.toMatch(/0x[0-9a-f]{6,}/i);
          expect(s, "a symbol").not.toContain("!");
          expect(s).not.toContain(sessionId);
          expect(s).not.toContain("echo_c");
        }
        // And every span attribute is a number.
        for (const span of lines.filter((l) => l.kind === "span")) {
          for (const value of Object.values(span.a ?? {})) expect(typeof value).toBe("number");
        }
      } finally {
        await cleanupSession(page, sessionId);
      }
    } finally {
      // Off before the collector goes away, so no batch is sent to a closed port.
      await configureMinimalStopSettings(page);
      await collector.close();
    }
  });
});
