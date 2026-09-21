const { _internal: I } = require('../../electron/portMapper.js');
let pass = 0, fail = 0;
const ok = (name, cond, extra) => { if (cond) { pass++; } else { fail++; console.log('  FAIL: ' + name + (extra ? '  -> ' + extra : '')); } };

// --- classifyExternal -------------------------------------------------------
const c = I.classifyExternal;
ok('public 203.x is NOT public (TEST-NET-3)', c('203.0.113.9').kind === 'bogus');
ok('real public', c('81.2.69.142').ok === true && c('81.2.69.142').kind === 'public');
ok('CGNAT 100.64', c('100.64.0.1').kind === 'cgnat');
ok('CGNAT 100.127 top of range', c('100.127.255.254').kind === 'cgnat');
ok('100.128 is NOT cgnat (outside /10)', c('100.128.0.1').kind !== 'cgnat', JSON.stringify(c('100.128.0.1')));
ok('RFC1918 10.x', c('10.1.2.3').kind === 'double-nat');
ok('RFC1918 192.168', c('192.168.1.1').kind === 'double-nat');
ok('RFC1918 172.16', c('172.16.0.1').kind === 'double-nat');
ok('172.32 is NOT private (outside /12)', c('172.32.0.1').kind !== 'double-nat', JSON.stringify(c('172.32.0.1')));
ok('172.15 is NOT private', c('172.15.0.1').kind !== 'double-nat');
ok('0.0.0.0 wan-down', c('0.0.0.0').kind === 'wan-down');
ok('169.254 wan-down', c('169.254.3.4').kind === 'wan-down');
ok('loopback bogus', c('127.0.0.1').kind === 'bogus');
ok('multicast bogus', c('239.1.1.1').kind === 'bogus');
ok('empty -> none', c('').kind === 'none');
ok('garbage -> none', c('not-an-ip').kind === 'none');

// --- tag() ------------------------------------------------------------------
ok('tag plain', I.tag('<a><NewExternalIPAddress>1.2.3.4</NewExternalIPAddress></a>', 'NewExternalIPAddress') === '1.2.3.4');
ok('tag namespaced', I.tag('<u:controlURL>/ctl</u:controlURL>', 'controlURL') === '/ctl');
ok('tag with attributes', I.tag('<errorCode xmlns="x">718</errorCode>', 'errorCode') === '718');
ok('tag entity decode', I.tag('<d>a&amp;b</d>', 'd') === 'a&b');
ok('tag missing -> empty', I.tag('<a>1</a>', 'zzz') === '');
ok('tag does not match prefix of another name',
   I.tag('<NewExternalPortRange>9</NewExternalPortRange><NewExternalPort>5</NewExternalPort>', 'NewExternalPort') === '5',
   I.tag('<NewExternalPortRange>9</NewExternalPortRange><NewExternalPort>5</NewExternalPort>', 'NewExternalPort'));

// --- servicesFrom: the classic controlURL bug -------------------------------
const DESC = `<?xml version="1.0"?><root xmlns="urn:schemas-upnp-org:device-1-0">
<device><deviceType>urn:schemas-upnp-org:device:InternetGatewayDevice:1</deviceType>
<serviceList>
 <service><serviceType>urn:schemas-upnp-org:service:Layer3Forwarding:1</serviceType>
  <controlURL>/ctl/L3F</controlURL></service>
</serviceList>
<deviceList><device><deviceType>urn:schemas-upnp-org:device:WANDevice:1</deviceType>
<serviceList>
 <service><serviceType>urn:schemas-upnp-org:service:WANCommonInterfaceConfig:1</serviceType>
  <controlURL>/ctl/CommonIfCfg</controlURL></service>
</serviceList>
<deviceList><device><deviceType>urn:schemas-upnp-org:device:WANConnectionDevice:1</deviceType>
<serviceList>
 <service><serviceType>urn:schemas-upnp-org:service:WANIPConnection:1</serviceType>
  <controlURL>/ctl/IPConn</controlURL></service>
</serviceList></device></deviceList></device></deviceList></device></root>`;

const svcs = I.servicesFrom(DESC, 'http://192.168.1.1:5000/rootDesc.xml');
ok('servicesFrom picks exactly one usable service', svcs.length === 1, JSON.stringify(svcs));
ok('servicesFrom got WANIPConnection (not Layer3Forwarding)', svcs[0] && svcs[0].serviceType.includes('WANIPConnection'));
ok('servicesFrom got the RIGHT controlURL, not the first in the doc',
   svcs[0] && svcs[0].controlUrl === 'http://192.168.1.1:5000/ctl/IPConn', svcs[0] && svcs[0].controlUrl);

// URLBase handling
const withBase = DESC.replace('<device>', '<URLBase>http://192.168.1.1:49152/</URLBase><device>');
const s2 = I.servicesFrom(withBase, 'http://192.168.1.1:5000/rootDesc.xml');
ok('URLBase wins over LOCATION', s2[0].controlUrl === 'http://192.168.1.1:49152/ctl/IPConn', s2[0].controlUrl);
ok('fallbackUrl resolves against LOCATION', s2[0].fallbackUrl === 'http://192.168.1.1:5000/ctl/IPConn', s2[0].fallbackUrl);

// absolute + path-relative controlURLs
const abs = DESC.replace('<controlURL>/ctl/IPConn</controlURL>', '<controlURL>http://10.0.0.1:80/x</controlURL>');
// new URL() normalises away the default :80 for http - correct, and harmless.
ok('absolute controlURL preserved', I.servicesFrom(abs, 'http://192.168.1.1:5000/d.xml')[0].controlUrl === 'http://10.0.0.1/x',
   I.servicesFrom(abs, 'http://192.168.1.1:5000/d.xml')[0].controlUrl);
const abs2 = DESC.replace('<controlURL>/ctl/IPConn</controlURL>', '<controlURL>http://10.0.0.1:49152/x</controlURL>');
ok('absolute controlURL keeps a non-default port',
   I.servicesFrom(abs2, 'http://192.168.1.1:5000/d.xml')[0].controlUrl === 'http://10.0.0.1:49152/x');
const rel = DESC.replace('<controlURL>/ctl/IPConn</controlURL>', '<controlURL>ctl/IPConn</controlURL>');
ok('path-relative controlURL resolved', I.servicesFrom(rel, 'http://192.168.1.1:5000/sub/d.xml')[0].controlUrl === 'http://192.168.1.1:5000/sub/ctl/IPConn');

// service preference order
const both = DESC.replace('urn:schemas-upnp-org:service:Layer3Forwarding:1', 'urn:schemas-upnp-org:service:WANPPPConnection:1');
const s3 = I.servicesFrom(both, 'http://192.168.1.1:5000/d.xml');
ok('two services found', s3.length === 2, JSON.stringify(s3.map(s=>s.serviceType)));
ok('WANIPConnection:1 preferred over WANPPPConnection:1', s3[0].serviceType.includes('WANIPConnection'), s3[0].serviceType);

// --- AddPortMapping argument ORDER (load-bearing) ---------------------------
const args = I.addMappingArgs(47811, 47811, '192.168.1.23', 'Beebo Media', 3600);
const order = ['NewRemoteHost','NewExternalPort','NewProtocol','NewInternalPort','NewInternalClient','NewEnabled','NewPortMappingDescription','NewLeaseDuration'];
let lastIdx = -1, orderOk = true;
for (const n of order) { const i = args.indexOf('<' + n + '>'); if (i <= lastIdx) { orderOk = false; break; } lastIdx = i; }
ok('AddPortMapping args in spec order', orderOk, args);
ok('NewRemoteHost is open+close, not self-closing', args.includes('<NewRemoteHost></NewRemoteHost>'));
ok('NewEnabled is 1 not true', args.includes('<NewEnabled>1</NewEnabled>'));
ok('NewProtocol uppercase TCP', args.includes('<NewProtocol>TCP</NewProtocol>'));

// --- alternatePorts ---------------------------------------------------------
const ap = I.alternatePorts(3);
ok('alternatePorts returns 3 distinct', ap.length === 3 && new Set(ap).size === 3);
ok('alternatePorts in dynamic range', ap.every(p => p >= 49152 && p <= 65535), JSON.stringify(ap));

console.log(`\npure functions: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
