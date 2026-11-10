/**
 * Patches Baileys (7.0.0-rc13) in node_modules for two inbound-message stalls.
 * Every replacement must match exactly once; otherwise the build fails, so a
 * Baileys upgrade can never ship with a patch silently missing.
 *
 * 1. profilePictureUrl: do not send <tctoken> (rc.9 behaviour). The server never
 *    answers some of these queries, and each one waits the 60s query timeout.
 *    Set BAILEYS_PROFILE_PIC_TCTOKEN=true to restore the upstream behaviour.
 * 2. offline sync: request the next <offline_batch> after 3s without offline
 *    items. Upstream asks for a single batch of 100, so a device with a larger
 *    backlog never finishes the offline sync (WhiskeySockets/Baileys#2810).
 */
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..', '..', 'node_modules', 'baileys');
const expectedVersion = '7.0.0-rc13';
const version = require(path.join(root, 'package.json')).version;

if (version !== expectedVersion) {
  console.error(`[patch-baileys] expected baileys ${expectedVersion}, found ${version}. Review the patches.`);
  process.exit(1);
}

function patch(relativeFile, replacements) {
  const file = path.join(root, relativeFile);
  let source = fs.readFileSync(file, 'utf8');

  for (const [label, from, to] of replacements) {
    const count = source.split(from).length - 1;
    if (count !== 1) {
      console.error(`[patch-baileys] ${relativeFile}: "${label}" matched ${count} times, expected 1`);
      process.exit(1);
    }
    source = source.replace(from, to);
  }

  fs.writeFileSync(file, source);
  console.log(`[patch-baileys] ${relativeFile}: ${replacements.length} patch(es) applied`);
}

patch('lib/Socket/chats.js', [
  [
    'profile picture without tctoken',
    'if (serverProps.profilePicPrivacyToken && isUserJid && !isSelf) {',
    "if (process.env.BAILEYS_PROFILE_PIC_TCTOKEN === 'true' && serverProps.profilePicPrivacyToken && isUserJid && !isSelf) {",
  ],
]);

patch('lib/Socket/socket.js', [
  [
    'repeat offline_batch requests',
    `    ws.on('CB:ib,,offline_preview', async (node) => {
        logger.info('offline preview received', JSON.stringify(node));
        await sendNode({
            tag: 'ib',
            attrs: {},
            content: [{ tag: 'offline_batch', attrs: { count: '100' } }]
        });
    });`,
    `    let offlineBatchRequests = 0;
    let offlineBatchTimer;
    let offlineSyncDone = false;
    const requestOfflineBatch = async () => {
        offlineBatchRequests++;
        await sendNode({
            tag: 'ib',
            attrs: {},
            content: [{ tag: 'offline_batch', attrs: { count: '100' } }]
        });
    };
    const armOfflineBatchTimer = () => {
        if (offlineSyncDone) {
            return;
        }
        clearTimeout(offlineBatchTimer);
        offlineBatchTimer = setTimeout(() => {
            if (offlineSyncDone || !ws.isOpen || offlineBatchRequests >= 200) {
                return;
            }
            logger.info({ offlineBatchRequests }, 'requesting next offline batch');
            requestOfflineBatch()
                .then(armOfflineBatchTimer)
                .catch(err => logger.warn({ err }, 'failed to request next offline batch'));
        }, 3000);
    };
    for (const offlineTag of ['message', 'receipt', 'notification', 'call']) {
        ws.on(\`CB:\${offlineTag}\`, (offlineNode) => {
            const offlineAttr = offlineNode?.attrs?.offline;
            if (offlineAttr && offlineAttr !== '0') {
                armOfflineBatchTimer();
            }
        });
    }
    ws.on('close', () => {
        offlineSyncDone = true;
        clearTimeout(offlineBatchTimer);
    });
    ws.on('CB:ib,,offline_preview', async (node) => {
        logger.info('offline preview received', JSON.stringify(node));
        await requestOfflineBatch();
        armOfflineBatchTimer();
    });`,
  ],
  [
    'stop batching when offline sync completes',
    `    ws.on('CB:ib,,offline', (node) => {
        const child = getBinaryNodeChild(node, 'offline');`,
    `    ws.on('CB:ib,,offline', (node) => {
        offlineSyncDone = true;
        clearTimeout(offlineBatchTimer);
        const child = getBinaryNodeChild(node, 'offline');`,
  ],
]);
