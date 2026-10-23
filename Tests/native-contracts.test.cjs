const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { test } = require('node:test');

const root = path.join(__dirname, '..');
const client = path.join(root, 'Sources/native_lux/WebClient');

test('Lux is an unchanged, pinned Git submodule', () => {
    const modules = fs.readFileSync(path.join(root, '.gitmodules'), 'utf8');
    assert.match(modules, /path = Sources\/native_lux\/WebClient/);
    assert.equal(execFileSync('git', ['status', '--porcelain', '--untracked-files=all'], { cwd: client, encoding: 'utf8' }), '');
    assert.match(execFileSync('git', ['rev-parse', 'HEAD'], { cwd: client, encoding: 'utf8' }), /^[a-f0-9]{40}\n$/);
});

test('the resource allowlist includes upstream relative assets and excludes repository metadata', () => {
    const manifest = fs.readFileSync(path.join(root, 'Package.swift'), 'utf8');
    const resources = [...manifest.matchAll(/\.copy\("([^"]+)"\)/g)].map(match => match[1]);
    assert(resources.includes('NativeAdapter.js'));
    assert(!resources.includes('WebClient'));
    const relativeReferences = new Set();
    for (const file of ['index.html', 'index.js', 'manifest.json']) {
        const text = fs.readFileSync(path.join(client, file), 'utf8');
        for (const match of text.matchAll(/["']([\w.-]+\.(?:png|ico|js|css|json))["']/g)) relativeReferences.add(match[1]);
    }
    for (const reference of relativeReferences) assert(resources.includes(`WebClient/${reference}`), reference);
    for (const resource of resources) assert(fs.statSync(path.join(root, 'Sources/native_lux', resource)).isFile());
});

test('the adapter does not depend on Lux classes, signaling, or data channels', () => {
    const adapter = fs.readFileSync(path.join(root, 'Sources/native_lux/NativeAdapter.js'), 'utf8');
    assert.doesNotMatch(adapter, /VideoWindow|SetupWindow|RTCPeerConnection|sendOrdered|sendUnordered|\.orderedChannel|\.unorderedChannel/);
});

test('the wrapper leaves upstream credential storage completely alone', () => {
    const adapter = fs.readFileSync(path.join(root, 'Sources/native_lux/NativeAdapter.js'), 'utf8');
    const swift = fs.readFileSync(path.join(root, 'Sources/native_lux/ContentView.swift'), 'utf8');
    assert.doesNotMatch(adapter, /Storage\.prototype|["']credentials["']|["']password["']|Keychain|nativeLuxBootstrap/);
    assert.doesNotMatch(swift, /Security|CredentialStore|sessionPassword|Keychain/);
});

test('native input submission is immediate and retains April cursor flushing', () => {
    const swift = fs.readFileSync(path.join(root, 'Sources/native_lux/ContentView.swift'), 'utf8');
    assert.match(swift, /CATransaction\.commit\(\)\s*CATransaction\.flush\(\)/);
    assert.match(swift, /evaluateJavaScript\([^\n]*completionHandler: nil\)/);
    assert.doesNotMatch(swift, /CADisplayLink|NativeInputBuffer|deliveryInFlight|DispatchQueue\.main\.async/);
});

test('the app shows the top status bar, auto-hides the home indicator, and adds no web overlay', () => {
    const swift = fs.readFileSync(path.join(root, 'Sources/native_lux/ContentView.swift'), 'utf8');
    const adapter = fs.readFileSync(path.join(root, 'Sources/native_lux/NativeAdapter.js'), 'utf8');
    assert.match(swift, /prefersStatusBarHidden:\s*Bool\s*\{\s*false\s*\}/);
    assert.match(swift, /prefersHomeIndicatorAutoHidden:\s*Bool\s*\{\s*true\s*\}/);
    assert.doesNotMatch(adapter, /native-lux-controls|attachShadow|Capture mouse|Release mouse|position:\s*fixed/);
});

test('the video viewport reserves top status-bar space and cursor coordinates use that same viewport', () => {
    const swift = fs.readFileSync(path.join(root, 'Sources/native_lux/ContentView.swift'), 'utf8');
    assert.match(swift, /webView\.topAnchor\.constraint\(equalTo: root\.safeAreaLayoutGuide\.topAnchor\)/);
    assert.match(swift, /webView\.bottomAnchor\.constraint\(equalTo: root\.bottomAnchor\)/);
    assert.doesNotMatch(swift, /webView\.bottomAnchor\.constraint\(equalTo: root\.safeAreaLayoutGuide\.bottomAnchor\)/);
    assert.match(swift, /webView\.addSubview\(cursor\)/);
    assert.match(swift, /viewportSize = webView\.bounds\.size/);
    assert.match(swift, /gesture\.translation\(in: webView\)/);
    assert.doesNotMatch(swift, /\bview\.bounds/);
});

test('native metadata retains the application identity and permission descriptions', () => {
    const config = fs.readFileSync(path.join(root, 'xtool.yml'), 'utf8');
    const plist = fs.readFileSync(path.join(root, 'Info.plist'), 'utf8');
    assert.match(config, /bundleID: com\.optimal\.lux/);
    assert.match(config, /iconPath: Sources\/native_lux\/WebClient\/apple-touch-icon\.png/);
    for (const key of ['CFBundleDisplayName', 'CFBundleName']) {
        assert.match(plist, new RegExp(`<key>${key}</key>\\s*<string>Lux</string>`));
    }
    for (const key of ['NSCameraUsageDescription', 'NSLocalNetworkUsageDescription', 'UIApplicationSupportsIndirectInputEvents']) {
        assert(plist.includes(`<key>${key}</key>`));
    }
});
