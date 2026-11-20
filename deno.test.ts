// Deno-native smoke tests for the BEYOND AI HTTP backend.
// The production server remains Node.js; Deno launches it as a child process
// and verifies the public HTTP contract from Deno's test runner.

const serverPath = new URL('../server.js', import.meta.url).pathname;

Deno.test({
  name: 'backend health and premium status endpoints',
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const listener = Deno.listen({ hostname: '127.0.0.1', port: 0 });
    const port = listener.addr.port;
    listener.close();

    const dataDir = await Deno.makeTempDir({ prefix: 'beyond-deno-' });
    const command = new Deno.Command(Deno.env.get('NODE_BIN') ?? 'node', {
      args: [serverPath],
      env: {
        PORT: String(port),
        DATA_DIR: dataDir,
        SERVE_FRONTEND: 'false',
        PREMIUM_REQUIRED: 'false',
        TRUST_PROXY: 'false',
      },
      stdout: 'piped',
      stderr: 'piped',
    });
    const child = command.spawn();
    const base = `http://127.0.0.1:${port}`;
    let started = false;

    try {
      for (let attempt = 0; attempt < 100; attempt++) {
        try {
          const response = await fetch(`${base}/api/health`);
          if (response.ok) {
            const health = await response.json();
            if (health.ok === true) started = true;
            break;
          }
        } catch {
          // Server is still starting.
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
      }

      if (!started) {
        try { child.kill('SIGTERM'); } catch { /* already exited */ }
        const output = await child.output();
        throw new Error(
          `Node backend did not start.\n${new TextDecoder().decode(output.stderr)}`,
        );
      }

      const healthResponse = await fetch(`${base}/api/health`);
      if (!healthResponse.ok) throw new Error(`health returned ${healthResponse.status}`);
      const health = await healthResponse.json();
      if (health.ok !== true) throw new Error('health response did not report ok=true');

      const premiumResponse = await fetch(`${base}/api/premium/status`);
      if (!premiumResponse.ok) throw new Error(`premium status returned ${premiumResponse.status}`);
      const premium = await premiumResponse.json();
      if (premium.status?.premium_required !== false) {
        throw new Error('PREMIUM_REQUIRED=false was not reflected in premium status');
      }
    } finally {
      try {
        child.kill('SIGTERM');
      } catch {
        // The child may already have exited.
      }
      await child.status;
      await Deno.remove(dataDir, { recursive: true });
    }
  },
});
