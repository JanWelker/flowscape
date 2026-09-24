import { defineConfig } from "@playwright/test";

// The Go binary serves the built frontend; build both first (`make build`).
export default defineConfig({
  testDir: "e2e",
  timeout: 180_000,
  retries: 0,
  reporter: "list",
  use: {
    baseURL: "http://127.0.0.1:18081",
    viewport: { width: 1280, height: 720 },
    launchOptions: {
      args: [
        "--use-angle=swiftshader",
        "--enable-unsafe-swiftshader",
        "--ignore-gpu-blocklist",
        "--enable-webgl",
      ],
    },
  },
  webServer: {
    command: "cd .. && go run ./cmd/flowscape --demo --demo-speed 3 --listen 127.0.0.1:18081",
    url: "http://127.0.0.1:18081/readyz",
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
