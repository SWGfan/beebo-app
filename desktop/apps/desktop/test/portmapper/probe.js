/*
 * Test automatic port mapping against THIS machine's real router.
 *
 * Run: node probe.js
 *
 * Makes a real mapping for TCP 47811, reports what happened, then removes it
 * again. Nothing is left behind.
 */
const { createPortMapper } = require('../../electron/portMapper.js');

const line = (s) => console.log(s);

(async () => {
  line('');
  line('  Beebo - automatic port mapping test');
  line('  ' + '-'.repeat(56));
  line('');

  const mapper = createPortMapper({
    port: 47811,
    description: 'Beebo Media (test)',
    log: (m) => line('    ' + m),
  });

  mapper.start();

  // Give it room: SSDP alone is a 3s window, and SOAP to flash is slow.
  await new Promise((r) => setTimeout(r, 20000));

  const s = mapper.status();
  line('');
  line('  ' + '-'.repeat(56));
  line('  RESULT');
  line('  ' + '-'.repeat(56));
  line(`    router            ${s.gateway || '(not found)'}`);
  line(`    this machine      ${s.localIp || '(not found)'}`);
  line(`    method            ${s.method || '(none worked)'}`);
  line(`    port opened       ${s.active ? 'YES' : 'no'}`);
  line(`    external address  ${s.externalIp || '(none)'}${s.externalPort ? ':' + s.externalPort : ''}`);
  line(`    reachable         ${s.reachable ? 'YES' : 'no'}`);
  if (!s.reachable && s.reason) {
    line('');
    line(`    why not:  ${s.reason}`);
  }
  line('');

  if (s.reachable) {
    line('  This router will open the port on its own. No port forwarding');
    line('  needed, and away-from-home can go direct - no Cloudflare.');
  } else if (s.kind === 'cgnat') {
    line('  Your provider is carrier-grade NATing you. No amount of router');
    line('  configuration fixes this - it needs peer-to-peer or a relay.');
  } else if (s.kind === 'double-nat') {
    line('  Two routers in a chain. Bridge mode on the first one would fix it.');
  } else if (s.kind === 'no-mapping') {
    line('  This router did not accept an automatic request. UPnP may be');
    line('  switched off in its settings - worth a look.');
  }

  line('');
  line('  Cleaning up the test mapping...');
  await mapper.stop();
  line('  Done. Nothing left behind.');
  line('');
  process.exit(0);
})().catch((e) => { console.error('  Test failed: ' + (e && e.message)); process.exit(1); });
