import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["apps/**/*.test.ts", "packages/**/*.test.ts"],
    // config.ts exits the process when a boot-required variable is missing,
    // which is right at boot and fatal in a test runner: importing anything
    // that transitively reaches it would take the whole suite down. The unit
    // tests never open a connection, so a syntactically valid URL is enough.
    env: {
      NODE_ENV: "test",
      DATABASE_URL: "postgres://sadhak:sadhak@localhost:5432/sadhak_test",
    },
  },
});
