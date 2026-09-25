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
  await page.waitForTimeout(3000);
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
});
