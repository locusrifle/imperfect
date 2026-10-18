import test from 'node:test';
import assert from 'node:assert/strict';
import { createStars, STARS, twistRate } from '../../../../website/stars.mjs';
import { readFile } from 'node:fs/promises';
import { TWIST, ROTATION } from '../../../../website/sky.mjs';
import { createBlackHole } from '../../../../website/blackhole/blackhole.mjs';

test('lock twist preserves every original star and leaves default website still', () => {
  const a = createStars({width:1472,height:920});
  const b = createStars({width:1472,height:920});
  a.place(1472,920,1716); b.place(1472,920,1716);
  const before = a.geometry.attributes.position.array.slice();
  const size = a.geometry.attributes.size.array.slice(), alpha = a.geometry.attributes.alpha.array.slice();
  for (const seconds of [0, 2, 10, 60, 600]) {
    a.tick(seconds,2,{twist:seconds}); b.tick(seconds,2);
    assert.equal(a.material.uniforms.uTwist.value,seconds);
    assert.equal(b.material.uniforms.uTwist.value,0);
    assert.deepEqual(a.geometry.attributes.position.array,before);
    assert.deepEqual(a.geometry.attributes.size.array,size);
    assert.deepEqual(a.geometry.attributes.alpha.array,alpha);
  }
  assert.equal(a.count,b.count);
  assert.equal(STARS.layers[0].count,2600);
  assert.match(a.material.vertexShader,/mat2\(c, s, -s, c\)/);
  a.geometry.dispose();a.material.dispose();b.geometry.dispose();b.material.dispose();
});

test('the lock\'s stars keep the wall clock imperfect keeps, and reduced motion holds them', async () => {
 const src = await readFile(new URL('../../../../website/boot/sequence.mjs', import.meta.url), 'utf8');
 assert.match(src, /import \{ twistAt, BOOT_ROTATION as SPIN, SKY_PIXELS, skyTime, inkOf, aim \} from '\.\.\/sky\.mjs'/);
 assert.match(src, /const now = wall\(\), still = reduced\.matches \|\| rv\.fade/);
 assert.match(src, /starTwist: twistAt\(now, \{ touched: rv\.wall, still \}\), starTime: still \? 0 : skyTime\(now, EPOCH\), starRotation: SPIN/);
 assert.doesNotMatch(src, /twistTime|twistLast/);
 const scene = await readFile(new URL('../../../../website/scene.mjs', import.meta.url), 'utf8');
 assert.match(scene, /starTwist = 0, starTime = t/);
 assert.match(scene, /stars\.tick\(starTime, renderer\.getPixelRatio\(\), \{ twinkle: motion, opacity: starOpacity, flow, twist: starTwist, rotation: starRotation \}\)/);
});

test('without avoid, the stars keep nothing clear: the website and the lock are as they were', () => {
  const a = createStars({width: 1472, height: 920});
  a.place(1472, 920, 1716); a.tick(3, 2);
  const U = a.material.uniforms;
  assert.equal(U.uAvoidCount.value, 0); assert.equal(U.uCaret.value.z, 0); assert.ok(U.uKick.value.every(k => k.w === 0));
  a.tick(3, 2, {avoid: {lines: [[0, 0, 10, 10]], caret: [5, 5, 4], kicks: [[5, 5, 2.9, 170]]}});
  assert.equal(U.uAvoidCount.value, 1); assert.equal(U.uCaret.value.z, 4); assert.equal(U.uKick.value[0].w, 170);
  a.tick(3, 2);
  assert.equal(U.uAvoidCount.value, 0); assert.equal(U.uKick.value[0].w, 0);
  a.geometry.dispose(); a.material.dispose();
});

test('the lock burst adds no eased angular unwind on top of the steady shader turn', () => {
  const positions = new Float32Array([120,40,0,-60,90,-20]);
  const angles = [Math.atan2(40,120),Math.atan2(90,-60)];
  const burst = createBlackHole({positions, sizes:new Float32Array([2,3]), alphas:new Float32Array([1,1]), center:{x:0,y:0,z:0}, radius:100, start:'explode', unwind:false});
  burst.update(0);
  for (let k=0;k<21;k++) {
    burst.update(0.1);
    for (let i=0;i<2;i++) assert.ok(Math.abs(Math.atan2(positions[3*i+1],positions[3*i])-angles[i])<1e-6);
  }
  assert.equal(burst.done,true);
});

test('only Countercurrent ships, with the same stars and resting-orbit shader', async () => {
  const a = createStars({width:1024,height:640}); a.place(1024,640,1200);
  const base = a.geometry.attributes.position.array.slice();
  assert.equal(TWIST, 'reverse');
  const sky = await readFile(new URL('../../../../website/sky.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(sky, /TWISTS|setTwistVariation|calm|swift|majestic|winding/);
  a.tick(10, 1, {twist:-10, rotation: ROTATION});
  assert.equal(a.material.uniforms.uTwist.value, -10);
  assert.deepEqual(a.material.uniforms.uRotation.value.toArray(), [ROTATION.centre, ROTATION.edge, ROTATION.hold, ROTATION.rest]);
  assert.deepEqual(a.geometry.attributes.position.array,base);
  assert.match(a.material.vertexShader,/if \(uTwist != 0\.0\)/);
  assert.match(a.material.vertexShader,/float r = length\(home\)/);
  // the shader states the same law as twistRate
  assert.match(a.material.vertexShader,/float angle = uTwist \* \(uRotation\.x \+ \(uRotation\.y - uRotation\.x\) \* min\(r, uRotation\.z\)\) \* \(1\.0 - smoothstep\(uRotation\.z, uRotation\.w, r\)\);/);
  assert.deepEqual(a.geometry.attributes.orbit.array,base);
  a.geometry.dispose(); a.material.dispose();
});

test('the twist turns slowly in the middle and faster outwards, every radius at one constant rate', () => {
  assert.deepEqual({ ...ROTATION }, { centre: 0.03, edge: 0.12, hold: 1.42, rest: 1.7 });
  assert.ok(ROTATION.hold > Math.SQRT2, 'still climbing at the screen\'s corners');
  let last = -1;
  for (let r = 0; r <= ROTATION.hold + 1e-9; r += 0.01) { const w = twistRate(r); assert.ok(w > last, `faster at ${r}`); last = w; }
  assert.ok(twistRate(0) * 3.9 < twistRate(1), 'the edge turns about four times as fast as the middle');
  assert.equal(twistRate(ROTATION.rest), 0);
  // constant in time: the angle is the rate times the twist's elapsed seconds, nothing else (sky.mjs twistAt)
  const a = createStars({ width: 1024, height: 640 }); a.place(1024, 640, 1200);
  for (const t of [1, 10, 100]) { a.tick(t, 1, { twist: -t, rotation: ROTATION }); assert.equal(a.material.uniforms.uTwist.value, -t); }
  assert.doesNotMatch(a.material.vertexShader, /uTime[^;]*angle|angle[^;]*uTime/);
  a.geometry.dispose(); a.material.dispose();
});

test('the field fills the whole disc the turn sweeps, its quiet middle is round and its little galaxies turn whole', () => {
  const W = 1536, H = 864, D = 1500, a = createStars({ width: W, height: H }); a.place(W, H, D);
  const o = a.geometry.attributes.orbit.array, an = a.geometry.attributes.anchor.array, kind = a.geometry.attributes.kind.array;
  const at = i => { const k = 1 - o[3 * i + 2] / D; return [(o[3 * i] - W / 2) / (W / 2 * k), (o[3 * i + 1] + H / 2) / (H / 2 * k)]; };
  // eight sectors of each ring out to rest hold the same number of plain stars, give or take chance
  for (const [r0, r1] of [[0.7, 1.0], [1.0, 1.2], [1.2, 1.42], [1.42, 1.7]]) {
    const sectors = new Array(8).fill(0);
    for (let i = 0; i < a.count; i++) {
      if (kind[i] !== 0 || an[2 * i] !== o[3 * i]) continue;
      const [x, y] = at(i), r = Math.hypot(x, y);
      if (r >= r0 && r < r1) sectors[Math.floor((Math.atan2(y, x) + Math.PI) / (Math.PI / 4)) % 8]++;
    }
    assert.ok(Math.min(...sectors) > 0.7 * Math.max(...sectors), `${r0}-${r1}: ${sectors}`); // no sector empty or thin
  }
  assert.deepEqual(Object.keys(STARS.quiet).sort(), ['dim', 'keep', 'radius']);
  // a galaxy's dots measure their rate from its core, so it turns as one
  let dots = 0;
  for (let i = 0; i < a.count; i++) if (an[2 * i] !== o[3 * i] || an[2 * i + 1] !== o[3 * i + 1]) {
    dots++;
    const core = [...Array(a.count).keys()].find(j => kind[j] === 2 && o[3 * j] === an[2 * i] && o[3 * j + 1] === an[2 * i + 1]);
    assert.ok(core !== undefined);
    if (dots > 20) break;
  }
  assert.ok(dots > 20);
  a.geometry.dispose(); a.material.dispose();
});
