import type { NextConfig } from "next";

const config: NextConfig = {
  transpilePackages: ["@pentefino/core", "@pentefino/db", "@pentefino/adapters", "@pentefino/ai", "@pentefino/jobs", "@pentefino/ui"],

  // Every workspace package (and this app's own lib/*) writes relative
  // imports with an explicit ".js" extension pointing at a ".ts" source
  // file - required by verbatimModuleSyntax + ESM, since those packages run
  // directly under Node's own ESM loader with no bundler in front of them
  // (apps/jobs, in particular). Vite/Vitest resolve that ".js" specifier to
  // the sibling ".ts" file automatically; webpack does not, by default, and
  // fails the build the moment `transpilePackages` above hands it one of
  // those packages' real TypeScript sources to compile (or this app's own
  // "@/lib/*.js" imports). `extensionAlias` tells webpack's resolver to try
  // ".ts"/".tsx" first for anything ending in ".js", closing that gap
  // without asking any package to drop the extension convention it needs
  // for its own non-bundled runtime.
  webpack(webpackConfig) {
    webpackConfig.resolve.extensionAlias = {
      ...webpackConfig.resolve.extensionAlias,
      ".js": [".ts", ".tsx", ".js"],
    };
    return webpackConfig;
  },
};

export default config;
