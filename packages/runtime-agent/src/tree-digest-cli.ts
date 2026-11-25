#!/usr/bin/env node
import { treeDigest } from './image';

/** `node dist/tree-digest-cli.js <rootfs-dir>` prints the image digest (`sha256:<hex>`) the attestation and the agent config use. Read-only. */
const dir = process.argv[2];
if (!dir) {
  console.error('usage: tree-digest-cli <dir>');
  process.exit(2);
}
treeDigest(dir).then(
  (d) => console.log(d),
  () => {
    console.error('REFUSED: directory unreadable');
    process.exit(1);
  },
);
