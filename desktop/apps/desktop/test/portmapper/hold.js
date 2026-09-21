/*
 * Open the port and HOLD it open, so an outside machine can be pointed at it
 * while we watch. Press a key to close it again cleanly.
 *
 * This exists to remove a variable. Testing from outside only means something if
 * we know for certain the door was open at that moment.
 */
const { createPortMapper } = require('../../electron/portMapper.js');
const net = require('net');

const PORT = 47811;
const line = (s) => console.log(s);

(async () => {
  line('');
  line('  Beebo - hold the port open for an outside test');
  line('  ' + '-'.repeat(58));
  line('');

  // Is the media server even listening? A forwarded port to nothing still fails.
  const listening = await new Promise((r) => {
    const s = net.connect({ host: '127.0.0.1', port: PORT, timeout: 3000 });
    s.on('connect', () => { s.destroy(); r(true); });
    s.on('error', () => r(false));
    s.on('timeout', () => { s.destroy(); r(false); });
  });
  line('    Beebo listening on this machine : ' + (listening ? 'YES' : 'NO  <-- start Beebo first!'));
  line('');

  const mapper = createPortMapper({ port: PORT, description: 'Beebo Media', log: (m) => line('    ' + m) });
  mapper.start();
  await new Promise((r) => setTimeout(r, 18000));

  const s = mapper.status();
  line('');
  line('  ' + '-'.repeat(58));
  if (s.active && s.reachable) {
    line('  THE PORT IS OPEN RIGHT NOW.');
    line('');
    line('    Try BOTH of these from your other computer:');
    line('');
    line('      https://example-house.duckdns.org:' + s.externalPort);
    line('      https://' + s.externalIp + ':' + s.externalPort + '   (expect a cert warning - that is fine)');
    line('');
    line('    The second one skips DNS entirely. If the name fails but the');
    line('    number works, the problem is DNS. If both fail, it is the port');
    line('    or the Windows firewall.');
  } else if (s.active) {
    line('  Mapped, but not reachable: ' + s.reason);
  } else {
    line('  Could not open the port: ' + (s.reason || 'unknown'));
  }
  line('  ' + '-'.repeat(58));
  line('');
  line('  Leaving it open. Go and test now.');
  line('  Press ENTER here when you are done, and I will close it properly.');
  line('');

  process.stdin.resume();
  process.stdin.once('data', async () => {
    line('  Closing the mapping...');
    await mapper.stop();
    line('  Done. Nothing left behind.');
    process.exit(0);
  });
})().catch((e) => { console.error('  Failed: ' + (e && e.message)); process.exit(1); });
