import { expect, test } from "@playwright/test";

test("renders the demo cluster and takes the README screenshot", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("console", (m) => {
    if (m.type() === "error" && !m.text().includes("favicon")) errors.push(m.text());
  });
  await page.goto("/");
  await page.waitForFunction(() => document.body.dataset.ready === "true", null, {
    timeout: 120_000,
  });
  // Let the sparks and the layout settle.
  await page.waitForTimeout(4000);

  const stats = await page.evaluate(() => {
    const f = window.flowscape;
    const gl = document.querySelector("canvas")?.getContext("webgl2");
    return {
      webgl: gl !== null && gl !== undefined,
      nodes: f.state.nodes.size,
      edges: f.state.edges.size,
      platforms: f.layout.platforms.size,
      sparks: f.particles.count,
      frames: f.host.frames,
    };
  });
  expect(stats.webgl).toBe(true);
  expect(stats.nodes).toBeGreaterThan(20);
  expect(stats.edges).toBeGreaterThan(30);
  expect(stats.platforms).toBeGreaterThan(5);
  expect(stats.sparks).toBeGreaterThan(0);
  expect(stats.frames).toBeGreaterThan(10);

  // Picking: the node under its projected position is that node.
  const picked = await page.evaluate(() => {
    const f = window.flowscape;
    const id = [...f.state.nodes.keys()].find((k) =>
      k.startsWith("nextcloud/Deployment/nextcloud"),
    )!;
    const t = f.layout.targets.get(id)!;
    const cam = f.host.camera;
    const e = cam.matrixWorldInverse.elements;
    const q = cam.projectionMatrix.elements;
    const x = e[0]! * t.x + e[4]! * t.y + e[8]! * t.z + e[12]!;
    const y = e[1]! * t.x + e[5]! * t.y + e[9]! * t.z + e[13]!;
    const z = e[2]! * t.x + e[6]! * t.y + e[10]! * t.z + e[14]!;
    const w = e[3]! * t.x + e[7]! * t.y + e[11]! * t.z + e[15]!;
    const cx = q[0]! * x + q[4]! * y + q[8]! * z + q[12]! * w;
    const cy = q[1]! * x + q[5]! * y + q[9]! * z + q[13]! * w;
    const cw = q[3]! * x + q[7]! * y + q[11]! * z + q[15]! * w;
    const r = document.querySelector("canvas")!.getBoundingClientRect();
    const sx = ((cx / cw + 1) / 2) * r.width + r.left;
    const sy = ((1 - cy / cw) / 2) * r.height + r.top;
    return { id, pick: f.picking.pick(sx, sy) };
  });
  expect(picked.pick).toEqual({ kind: "node", id: picked.id });

  await page.evaluate(({ id }) => window.flowscape.select({ kind: "node", id }), picked);
  await expect(page.locator("#panel h2")).toHaveText("nextcloud");
  await expect(page.locator("#panel .edge-row").first()).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.locator("#panel")).toBeHidden();

  await page.screenshot({ path: "../docs/screenshot.png" });
  expect(errors).toEqual([]);
});
