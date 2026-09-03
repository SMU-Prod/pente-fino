import type { NextConfig } from "next";

const config: NextConfig = {
  // RNF-03: LCP <= 2.0s on 4G. Measured at 2.4s with two separate
  // render-blocking stylesheets - 1.5 kB and 2.0 kB - costing an estimated
  // 820 ms between them. Not their size: their *count*. Two extra round
  // trips on Lighthouse's mobile profile, for 3.5 kB of CSS that fits
  // comfortably inside the document itself.
  //
  // `inlineCss` puts them in the HTML, so the first response carries
  // everything the first paint needs. Measured before and after; the
  // numbers are in the commit message.
  experimental: { inlineCss: true },

  transpilePackages: [
    "@pentefino/core", "@pentefino/db", "@pentefino/adapters", "@pentefino/ai", "@pentefino/jobs", "@pentefino/ui",
  ],

  // PGlite must never be bundled. It ships its Postgres extensions as
  // `.tar.gz` files it reads from disk at runtime; webpack turns those into
  // hashed static assets and rewrites the path to a `/_next/static/media/…`
  // URL, so PGlite then tries to open a URL where it wants a file and the
  // whole local database dies on boot with
  //
  //   Extension bundle not found: /_next/static/media/pg_trgm.tar.<hash>.gz
  //   TypeError: The "path" argument must be … Received an instance of URL
  //
  // This is why the local fallback database (client.ts, for anyone running
  // without DATABASE_URL) had never actually worked inside the app: the
  // package's own test harness runs under Vitest with no bundler in front
  // of it, so every suite passed while `pnpm dev` 500'd on the first query.
  // `serverExternalPackages` leaves it as a plain runtime require.
  serverExternalPackages: ["@electric-sql/pglite"],

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
  webpack(webpackConfig, { isServer }) {
    webpackConfig.resolve.extensionAlias = {
      ...webpackConfig.resolve.extensionAlias,
      ".js": [".ts", ".tsx", ".js"],
    };

    // `serverExternalPackages` above is not enough on its own here: PGlite
    // is reached transitively from `@pentefino/db`, which is in
    // `transpilePackages`, so webpack still walks into it and turns its
    // `.tar.gz` extension bundles into hashed static assets. This makes the
    // externalization explicit for the server build — every `@electric-sql/
    // pglite` specifier, subpaths included, stays a runtime require.
    if (isServer) {
      const externals = Array.isArray(webpackConfig.externals)
        ? webpackConfig.externals
        : [webpackConfig.externals].filter(Boolean);
      webpackConfig.externals = [
        ({ request }: { request?: string }, callback: (err?: Error | null, result?: string) => void) => {
          if (request?.startsWith("@electric-sql/pglite")) {
            return callback(null, `commonjs ${request}`);
          }
          return callback();
        },
        ...externals,
      ];
    }

    return webpackConfig;
  },
};

export default config;
