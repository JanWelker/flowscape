// Package web embeds the built frontend. Run `npm run build` in web/ first;
// dist/.gitkeep keeps the pattern valid in a fresh checkout.
package web

import "embed"

// Dist is the Vite build output.
//
//go:embed all:dist
var Dist embed.FS
