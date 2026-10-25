// install.sh's steps for the mic's ears, run for real with stand-ins for the
// tools that would build, download and start things: git, the compiler,
// CMake, curl and systemctl. What cannot run here (Vulkan, the GPU, the real
// model) is the PC's to check.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);
const root = resolve(import.meta.dirname, '..', '..', '..');
const MODEL = 'a stand-in for ggml-large-v3-turbo.bin';

async function computer(t, { tools = true, cmake = true } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'whisper-install-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const bin = join(dir, 'bin'), prefix = join(dir, 'imperfect'), log = join(dir, 'log');
  await mkdir(bin, { recursive: true });
  await mkdir(prefix, { recursive: true });
  const tool = (name, body) => writeFile(join(bin, name), `#!/bin/bash\necho "${name} $*" >> "${log}"\n${body}\n`, { mode: 0o755 });
  // git: a fetched checkout is a folder whose HEAD is the commit asked for.
  await tool('git', `dir="$2"; shift 2
case "$1" in
  rev-parse) cat "$dir/.head" 2>/dev/null || exit 1 ;;
  init) mkdir -p "$dir" ;;
  fetch) echo "\${@: -1}" > "$dir/.fetched" ;;
  -c) cp "$dir/.fetched" "$dir/.head" ;;
esac`);
  if (tools) for (const name of ['c++', 'make', 'glslc']) await tool(name, '');
  const fakeCmake = `case "$1" in
  -S) for arg; do [[ "$prev" == -B ]] && build="$arg"; prev="$arg"; done; mkdir -p "$build"; echo "$@" > "$build/configured" ;;
  --build) mkdir -p "$2/bin"; printf '#!/bin/sh\\n' > "$2/bin/whisper-server"; chmod 755 "$2/bin/whisper-server" ;;
esac`;
  if (cmake) await tool('cmake', fakeCmake);
  // Kitware's release, as a tarball holding the same stand-in CMake.
  const arch = (await run('uname', ['-m'])).stdout.trim();
  const release = join(dir, 'release'), tarball = join(dir, 'cmake.tar.gz');
  await mkdir(join(release, `cmake-3.31.6-linux-${arch}`, 'bin'), { recursive: true });
  await writeFile(join(release, `cmake-3.31.6-linux-${arch}`, 'bin', 'cmake'), `#!/bin/bash\necho "cmake $*" >> "${log}"\n${fakeCmake}\n`, { mode: 0o755 });
  await run('tar', ['czf', tarball, '-C', release, '.']);
  const cmakeSha = createHash('sha256').update(await readFile(tarball)).digest('hex');
  await tool('curl', `while [[ $# -gt 0 ]]; do [[ "$1" == -o ]] && out="$2"; url="$1"; shift; done
if [[ "$url" == *cmake-*.tar.gz ]]; then cp "${tarball}" "$out"; else printf '%s' "${MODEL}" > "$out"; fi`);
  await tool('systemctl', '');
  await tool('nproc', 'echo 4');
  const sha = createHash('sha256').update(MODEL).digest('hex');
  const install = async (home, extra = '') => {
    const script = `source <(sed '/^case "\${1:-install}"/,$d' "${join(root, 'install.sh')}")
ROOT="${root}"
vulkan_library() { echo /usr/lib/libvulkan.so; }
WHISPER_MODEL_SHA256=${sha}; WHISPER_MODEL_BYTES=${Buffer.byteLength(MODEL)}; CMAKE_SHA256[${arch}]=${cmakeSha}
${extra}
whisper_ears "$(command -v node)" ${home}`;
    const { stdout, stderr } = await run('bash', ['-c', script], { env: { PATH: `${bin}:${process.env.PATH}`, HOME: dir, IMPERFECT_PREFIX: prefix, XDG_CONFIG_HOME: join(dir, 'config') } });
    return { stdout, stderr };
  };
  const calls = async () => (await readFile(log, 'utf8').catch(() => '')).trim().split('\n').filter(Boolean);
  return { dir, prefix, install, calls, unit: join(dir, 'config', 'systemd', 'user', 'imperfect-whisper.service'), sha };
}

test('on the PC it builds whisper.cpp at the pinned commit with Vulkan, fetches the model, and keeps Whisper loaded on the port in machine.json', async t => {
  const pc = await computer(t);
  await writeFile(join(pc.prefix, 'machine.json'), JSON.stringify({ whisper: { port: 6001 } }));
  await mkdir(join(pc.prefix, 'models', 'parakeet-tdt-0.6b-v2-int8'), { recursive: true });
  await pc.install(0);
  const unit = await readFile(pc.unit, 'utf8');
  const server = join(pc.prefix, 'whisper', 'whisper.cpp', 'build', 'bin', 'whisper-server');
  assert.match(unit, new RegExp(`ExecStart=${server} --host 127\\.0\\.0\\.1 --port 6001 -m ${join(pc.prefix, 'models', 'ggml-large-v3-turbo.bin')} -t 4 -bs 5 -bo 5 -l en -nc\n`));
  assert.match(unit, /Restart=always/);
  assert.match(unit, /WantedBy=default\.target/);
  assert.equal(await readFile(join(pc.prefix, 'whisper', 'whisper.cpp', '.head'), 'utf8'), '4979e04f5dcaccb36057e059bbaed8a2f5288315\n');
  const configured = await readFile(join(pc.prefix, 'whisper', 'whisper.cpp', 'build', 'configured'), 'utf8');
  for (const flag of ['-DGGML_VULKAN=ON', '-DWHISPER_BUILD_TESTS=OFF', '-DCMAKE_BUILD_TYPE=Release', '-DVulkan_LIBRARY=/usr/lib/libvulkan.so']) assert.ok(configured.includes(flag), flag);
  assert.equal(await readFile(join(pc.prefix, 'models', 'ggml-large-v3-turbo.bin'), 'utf8'), MODEL);
  assert.equal(await readFile(join(pc.prefix, 'vocabulary.txt'), 'utf8'), '', 'an empty list is started, for the owner\'s agent to fill');
  assert.equal(((await stat(join(pc.prefix, 'vocabulary.txt'))).mode & 0o777), 0o600);
  await assert.rejects(stat(join(pc.prefix, 'models', 'parakeet-tdt-0.6b-v2-int8')), 'Parakeet\'s model is removed');
  const first = await pc.calls();
  assert.ok(first.includes('systemctl --user restart imperfect-whisper.service'));
  assert.equal(first.filter(line => line.startsWith('cmake --build')).length, 1);

  // Again, as after an update: nothing is rebuilt, fetched or restarted, and the list is the owner's.
  await writeFile(join(pc.prefix, 'vocabulary.txt'), 'Vaita\n');
  await pc.install(0);
  const second = (await pc.calls()).slice(first.length);
  assert.ok(!second.some(line => /^(cmake|curl|git .* fetch)/.test(line)), second.join('\n'));
  assert.ok(!second.includes('systemctl --user restart imperfect-whisper.service'));
  assert.ok(second.includes('systemctl --user enable --now imperfect-whisper.service'));
  assert.equal(await readFile(join(pc.prefix, 'vocabulary.txt'), 'utf8'), 'Vaita\n');
});

test('without CMake or the Vulkan headers it fetches them, pinned, without root', async t => {
  const pc = await computer(t, { cmake: false });
  // As on the owner's PC: no cmake, and no vulkan.h under /usr/include.
  await pc.install(0, `command() { [[ "$1 $2" == "-v cmake" ]] && return 1; builtin command "$@"; }
vulkan_headers() { return 1; }`);
  const calls = await pc.calls();
  assert.ok(calls.some(line => line.includes(`https://github.com/Kitware/CMake/releases/download/v3.31.6/cmake-3.31.6-linux-`)), 'CMake from Kitware\'s release');
  assert.ok(calls.some(line => line.endsWith('fetch --quiet --depth 1 https://github.com/KhronosGroup/Vulkan-Headers.git 952f776f6573aafbb62ea717d871cd1d6816c387')), calls.join('\n'));
  const configured = await readFile(join(pc.prefix, 'whisper', 'whisper.cpp', 'build', 'configured'), 'utf8');
  assert.ok(configured.includes(`-DVulkan_INCLUDE_DIR=${join(pc.prefix, 'whisper', 'vulkan-headers', 'include')}`), configured);
  assert.ok(await stat(pc.unit), 'the unit is written, built with the fetched CMake');
});

test('a model that does not match its checksum is refused, and nothing is started', async t => {
  const pc = await computer(t);
  const { stderr } = await pc.install(0, 'WHISPER_MODEL_SHA256=0000000000000000000000000000000000000000000000000000000000000000');
  assert.match(stderr, /did not match its checksum/);
  await assert.rejects(stat(join(pc.prefix, 'models', 'ggml-large-v3-turbo.bin')));
  await assert.rejects(stat(pc.unit));
});

test('without a compiler or glslc it says what to install, and the rest of the install goes on', async t => {
  const pc = await computer(t, { tools: false });
  const { stderr } = await pc.install(0, 'command() { [[ "$2" == c++ || "$2" == make || "$2" == glslc ]] && return 1; builtin command "$@"; }');
  assert.match(stderr, /the mic's ears need c\+\+ make glslc to build/);
  await assert.rejects(stat(pc.unit));
  assert.equal(await readFile(join(pc.prefix, 'vocabulary.txt'), 'utf8'), '');
});

test('a computer that follows the PC runs no Whisper of its own, and stops one it had', async t => {
  const laptop = await computer(t);
  await mkdir(join(laptop.dir, 'config', 'systemd', 'user'), { recursive: true });
  await writeFile(laptop.unit, '[Service]\n');
  await laptop.install(1);
  await assert.rejects(stat(laptop.unit));
  await assert.rejects(stat(join(laptop.prefix, 'vocabulary.txt')));
  const calls = await laptop.calls();
  assert.ok(calls.includes('systemctl --user disable --now imperfect-whisper.service'));
  assert.ok(!calls.some(line => /^(cmake|curl)/.test(line)));
  // Unknown (the tailnet is down): nothing is touched either way.
  await writeFile(laptop.unit, '[Service]\n');
  await laptop.install(2);
  assert.ok(await stat(laptop.unit));
});

test('undo removes the Whisper service with the others', async () => {
  const script = await readFile(join(root, 'install.sh'), 'utf8');
  const teardown = script.slice(script.indexOf('teardown() {'), script.indexOf('\n}\n', script.indexOf('teardown() {')));
  assert.match(teardown, /disable --now "\$MEMORY\.timer" "\$WHISPER"/);
  assert.match(teardown, /"\$UNIT_DIR\/\$WHISPER"/);
});
