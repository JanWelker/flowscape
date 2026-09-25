import { defineConfig } from "@playwright/test";

const launchOptions = {
  args: [
    "--use-angle=swiftshader",
    "--enable-unsafe-swiftshader",
    "--ignore-gpu-blocklist",
    "--enable-webgl",
  ],
};

// Two builds: the Go binary serving the embedded frontend (`make web`), and
// the static GitHub Pages demo with the WebAssembly source (`make pages`).
export default defineConfig({
  testDir: "e2e",
  timeout: 180_000,
  retries: 0,
  reporter: "list",
  projects: [
    {
      name: "server",
      testMatch: "screenshot.spec.ts",
      use: {
        baseURL: "http://127.0.0.1:18081",
        viewport: { width: 1280, height: 720 },
        launchOptions,
      },
    },
    {
      name: "pages",
      testMatch: "static-demo.spec.ts",
      use: {
        baseURL: "http://127.0.0.1:18082/flowscape/",
        viewport: { width: 1280, height: 720 },
        launchOptions,
      },
    },
  ],
  webServer: [
    {
      command: "cd .. && go run ./cmd/flowscape --demo --demo-speed 3 --listen 127.0.0.1:18081",
      url: "http://127.0.0.1:18081/readyz",
      reuseExistingServer: false,
      timeout: 120_000,
    },
    {
      command: "npx vite preview --outDir dist-pages --base /flowscape/ --host 127.0.0.1 --port 18082 --strictPort",
      url: "http://127.0.0.1:18082/flowscape/",
      reuseExistingServer: false,
      timeout: 60_000,
    },
  ],
});
