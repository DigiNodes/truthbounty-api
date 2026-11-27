const packageCache = new Map();

async function loadPackage(packageName, context, loaderFn) {
  if (packageCache.has(packageName)) return packageCache.get(packageName);
  try {
    const pkg = loaderFn ? await loaderFn() : require(packageName);
    packageCache.set(packageName, pkg);
    return pkg;
  } catch (e) {
    return null;
  }
}

function loadPackageSync(packageName, context, loaderFn) {
  if (packageCache.has(packageName)) return packageCache.get(packageName);
  try {
    const pkg = loaderFn ? loaderFn() : require(packageName);
    packageCache.set(packageName, pkg);
    return pkg;
  } catch (e) {
    return null;
  }
}

function loadPackageCached(packageName, context) {
  return loadPackageSync(packageName, context);
}

async function tryLoadPackage(packageName, loaderFn) {
  if (packageCache.has(packageName)) return packageCache.get(packageName);
  try {
    const pkg = loaderFn ? await loaderFn() : require(packageName);
    packageCache.set(packageName, pkg);
    return pkg;
  } catch (e) {
    return null;
  }
}

module.exports = {
  loadPackage,
  loadPackageSync,
  loadPackageCached,
  tryLoadPackage,
};
