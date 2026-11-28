import { defineConfig } from 'prisma/config';

// Client generation reads the schema only; CI and image builds need no database
// credentials. Database commands keep using prisma.config.ts and its required URL.
export default defineConfig({
  schema: 'prisma/schema.prisma',
});
