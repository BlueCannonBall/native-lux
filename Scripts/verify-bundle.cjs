const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const bundle = process.argv[2] || path.join(root, 'xtool/Lux Client.app/Lux Client_native_lux.bundle');
const manifest = fs.readFileSync(path.join(root, 'Package.swift'), 'utf8');
const resources = [...manifest.matchAll(/\.copy\("([^"]+)"\)/g)].map(match => match[1]);

assert(fs.existsSync(bundle), `Missing app resource bundle: ${bundle}. Run xtool dev build first.`);
assert.deepEqual(fs.readdirSync(bundle).sort(), [...resources.map(file => path.basename(file)), 'Info.plist'].sort(),
    'Bundle contains unexpected files, directories, Git metadata, or stale resources');
for (const resource of resources) {
    const source = path.join(root, 'Sources/native_lux', resource);
    const destination = path.join(bundle, path.basename(resource));
    assert(fs.readFileSync(source).equals(fs.readFileSync(destination)), `Bundled ${resource} differs from source`);
}
console.log(`Verified ${resources.length} byte-identical resources; no extra files or repository metadata`);
