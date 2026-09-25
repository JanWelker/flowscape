import { expect, test } from "@playwright/test";

test("the static demo runs the Go source in the browser", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("console", (m) => {
    if (m.type() === "error" && !m.text().includes("favicon")) errors.push(m.text());
  });
  await page.goto("./");
  await page.waitForFunction(() => document.body.dataset.ready === "true", null, {
    timeout: 120_000,
  });
  // The rarer conversations (drops, ICMP) take a few seconds to appear.
  await page.waitForFunction(
    () => {
      const edges = [...window.flowscape.state.edges.values()];
      return (
        edges.some((e) => e.proto === "ICMP") &&
        edges.some((e) => e.drops) &&
        edges.some((e) => e.totals[2] > 0) &&
        window.flowscape.particles.count > 0
      );
    },
    null,
    { timeout: 60_000 },
  );
  const stats = await page.evaluate(() => ({
    nodes: window.flowscape.state.nodes.size,
    edges: window.flowscape.state.edges.size,
    sparks: window.flowscape.particles.count,
    pill: document.querySelector("#pill .text")?.textContent ?? "",
    banner: document.querySelector("#filters .banner")?.textContent ?? "",
    wasm: typeof window.flowscapeDemoStart,
  }));
  expect(stats.wasm).toBe("function");
  expect(stats.nodes).toBeGreaterThan(20);
  expect(stats.edges).toBeGreaterThan(30);
  expect(stats.sparks).toBeGreaterThan(0);
  expect(stats.pill).toContain("demo");
  expect(stats.banner).toContain("in your browser");
  expect(errors).toEqual([]);

  // The demo contract: everything the UI can show, the demo cluster shows.
  // A feature that adds a field here without teaching the demo source to
  // produce it fails this test, and the live demo would silently lack it.
  const coverage = await page.evaluate(() => {
    const s = window.flowscape.state;
    const nodes = [...s.nodes.values()];
    const edges = [...s.edges.values()];
    const sum = (i: number) => edges.reduce((a, e) => a + e.totals[i]!, 0);
    return {
      namespaces: new Set(nodes.filter((n) => n.ns !== "reserved").map((n) => n.ns)).size,
      placed: nodes.filter((n) => n.ns !== "reserved" && n.machine).length,
      unplaced: nodes.filter((n) => n.ns !== "reserved" && !n.machine).length,
      machineAnchors: nodes.filter((n) => n.kind === "node").length,
      worldNames: nodes.filter((n) => n.kind === "world" && n.fqdn).length,
      ingress: nodes.some((n) => n.kind === "ingress"),
      apiserver: nodes.some((n) => n.kind === "kube-apiserver"),
      http: edges.filter((e) => e.l7?.http).length,
      dns: edges.filter((e) => e.l7?.dns).length,
      dropped: sum(1),
      audit: sum(2),
      drops: edges.filter((e) => e.drops).length,
      protocols: [...new Set(edges.map((e) => e.proto))].sort(),
    };
  });
  expect(coverage.namespaces).toBeGreaterThanOrEqual(8);
  expect(coverage.placed).toBeGreaterThan(15);
  expect(coverage.unplaced).toBe(0);
  expect(coverage.machineAnchors).toBeGreaterThanOrEqual(3);
  expect(coverage.worldNames).toBeGreaterThanOrEqual(5);
  expect(coverage.ingress).toBe(true);
  expect(coverage.apiserver).toBe(true);
  expect(coverage.http).toBeGreaterThan(3);
  expect(coverage.dns).toBeGreaterThan(1);
  expect(coverage.dropped).toBeGreaterThan(0);
  expect(coverage.audit).toBeGreaterThan(0);
  expect(coverage.drops).toBeGreaterThan(0);
  expect(coverage.protocols).toEqual(["ICMP", "TCP", "UDP"]);
});
