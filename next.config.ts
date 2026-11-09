import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Fully static site: `next build` emits plain HTML/JS/CSS into `out/`.
  // There is no Node server at runtime. All PDF parsing and SQLite storage
  // happen in the visitor's browser, so nothing is ever posted to a server.
  output: "export",

  // next/image optimization needs a server; disable it for static export.
  images: { unoptimized: true },

  // If you deploy under a subpath (e.g. GitHub Pages at /myrepo), set these:
  // basePath: "/myrepo",
  // assetPrefix: "/myrepo/",

  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
