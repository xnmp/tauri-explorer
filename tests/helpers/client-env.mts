// Node environment whose modules are transformed for the client, so Svelte
// effects and deriveds run for real (see vitest.client.config.ts).
export default {
  name: "client-node",
  viteEnvironment: "client",
  setup() { return { teardown() {} }; },
};
