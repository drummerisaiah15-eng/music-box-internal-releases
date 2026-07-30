'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const PROJECT_DIR = path.resolve(__dirname, '..');
const VENDOR_DIR = path.join(PROJECT_DIR, 'vendor');

const ASSETS = Object.freeze([
  {
    packageName: 'firebase',
    packageVersion: '12.15.0',
    source: 'firebase-app-compat.js',
    destination: 'firebase-12.15.0/firebase-app-compat.js',
  },
  {
    packageName: 'firebase',
    packageVersion: '12.15.0',
    source: 'firebase-firestore-compat.js',
    destination: 'firebase-12.15.0/firebase-firestore-compat.js',
  },
  {
    packageName: 'firebase',
    packageVersion: '12.15.0',
    source: 'firebase-auth-compat.js',
    destination: 'firebase-12.15.0/firebase-auth-compat.js',
  },
  {
    packageName: 'firebase',
    packageVersion: '12.15.0',
    source: 'firebase-app-check-compat.js',
    destination: 'firebase-12.15.0/firebase-app-check-compat.js',
  },
  {
    packageName: 'xlsx',
    packageVersion: '0.20.3',
    source: 'dist/xlsx.full.min.js',
    destination: 'sheetjs-0.20.3/xlsx.full.min.js',
  },
]);

function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function resolvePackageRoot(packageName) {
  try {
    return path.dirname(require.resolve(`${packageName}/package.json`, {
      paths: [PROJECT_DIR],
    }));
  } catch (error) {
    if (error.code !== 'ERR_PACKAGE_PATH_NOT_EXPORTED') throw error;
  }

  let current = path.dirname(require.resolve(packageName, { paths: [PROJECT_DIR] }));
  while (current !== path.dirname(current)) {
    const metadataPath = path.join(current, 'package.json');
    if (fs.existsSync(metadataPath)) {
      const metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf8'));
      if (metadata.name === packageName) return current;
    }
    current = path.dirname(current);
  }
  throw new Error(`Could not locate package root for ${packageName}`);
}

function prepareVendorAssets({ vendorDir = VENDOR_DIR } = {}) {
  fs.rmSync(vendorDir, { recursive: true, force: true });
  fs.mkdirSync(vendorDir, { recursive: true });

  const manifest = {
    generatedBy: 'tests/prepare-vendor.js',
    assets: [],
  };

  for (const asset of ASSETS) {
    const packageRoot = resolvePackageRoot(asset.packageName);
    const packageMetadata = JSON.parse(
      fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf8'),
    );
    if (packageMetadata.version !== asset.packageVersion) {
      throw new Error(
        `${asset.packageName} version mismatch: expected ${asset.packageVersion}, ` +
        `found ${packageMetadata.version}`,
      );
    }

    const sourcePath = path.join(packageRoot, asset.source);
    const destinationPath = path.join(vendorDir, asset.destination);
    const contents = fs.readFileSync(sourcePath);
    fs.mkdirSync(path.dirname(destinationPath), { recursive: true });
    fs.writeFileSync(destinationPath, contents, { mode: 0o644 });
    manifest.assets.push({
      package: `${asset.packageName}@${asset.packageVersion}`,
      path: asset.destination,
      bytes: contents.length,
      sha256: sha256(contents),
    });
  }

  fs.writeFileSync(
    path.join(vendorDir, 'manifest.json'),
    `${JSON.stringify(manifest, null, 2)}\n`,
    { mode: 0o644 },
  );
  return manifest;
}

if (require.main === module) {
  const manifest = prepareVendorAssets();
  console.log(`Prepared ${manifest.assets.length} pinned browser assets in vendor/.`);
}

module.exports = {
  ASSETS,
  prepareVendorAssets,
};
