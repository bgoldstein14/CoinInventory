const esbuild = require('esbuild');
const path = require('path');
const wd = path.resolve('.');

async function testBuild(label, opts) {
  try {
    const r = await esbuild.build({ ...opts, write: false, absWorkingDir: wd });
    console.log(label, 'OK, outputs:', r.outputFiles?.length);
  } catch(e) {
    console.error(label, 'FAIL:', e.message.split('\n').slice(0,3).join('\n'));
  }
}

(async () => {
  console.log('WD:', wd);

  // Test 1: basic TS bundle
  await testBuild('TS bundle', {
    entryPoints: ['src/main.ts'],
    bundle: true,
    outdir: 'dist',
    format: 'esm',
    platform: 'browser',
  });

  // Test 2: SCSS as css
  await testBuild('SCSS as CSS', {
    entryPoints: ['src/styles.scss'],
    bundle: true,
    outdir: 'dist',
    loader: { '.scss': 'css' },
  });

  // Test 3: TS with Angular-like options
  await testBuild('Angular-like', {
    entryPoints: ['src/main.ts'],
    bundle: true,
    outdir: 'dist',
    format: 'esm',
    platform: 'browser',
    target: 'es2022',
    conditions: ['es2020', 'es2015', 'module'],
    resolveExtensions: ['.ts', '.tsx', '.mjs', '.js'],
    metafile: true,
    legalComments: 'none',
    splitting: true,
  });
})();
