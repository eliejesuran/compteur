import { defineConfig } from 'vitest/config';
import { cloudflareTest } from '@cloudflare/vitest-pool-workers';

// R5 : tests d'intégration du Worker CF (index.js + EventDO + RegistryDO)
// exécutés dans le vrai runtime workerd via @cloudflare/vitest-pool-workers (v4 API).
// Les bindings (DO, migrations) sont lus depuis wrangler.jsonc.
export default defineConfig({
  plugins: [
    // isolatedStorage (défaut) : le storage des DO est remis à zéro entre chaque test.
    cloudflareTest({
      wrangler: { configPath: './wrangler.jsonc' },
    }),
  ],
  test: {
    include: ['tests/worker/**/*.test.js'],
  },
});
