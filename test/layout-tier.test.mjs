// The Android shell's column tier must reflow at the renderer's own width
// breakpoints. layoutTier is a pure function of the width, so the rule is
// checked against the renderer's Breakpoint::from_width without an emulator:
// the Java constants and branch order are read from the real source, the
// renderer's boundaries are read from the real layout.rs, and the extracted
// rule is evaluated for every width.
'use strict';

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MAIN_ACTIVITY = path.join(
  ROOT, 'android', 'app', 'src', 'main', 'java', 'org', 'opurom', 'mobile', 'MainActivity.java');
const RENDERER_LAYOUT = path.resolve(ROOT, '..', 'opurom-render', 'src', 'layout.rs');

function javaIntConstants(source) {
  const map = new Map();
  for (const match of source.matchAll(/static\s+final\s+int\s+([A-Z0-9_]+)\s*=\s*(\d+)\s*;/g)) {
    map.set(match[1], Number(match[2]));
  }
  return map;
}

// Reads `static int layoutTier(int widthDp)` as an ordered list of
// (threshold, tier) guards plus the fallback tier.
function readLayoutTierRule(source) {
  const method = /static\s+int\s+layoutTier\(int\s+widthDp\)\s*\{([\s\S]*?)\}/.exec(source);
  assert.ok(method, 'MainActivity declares a static layoutTier(int widthDp) method');
  const constants = javaIntConstants(source);
  const guards = [];
  for (const match of method[1].matchAll(/widthDp\s*>=\s*([A-Z0-9_]+)\s*\)\s*return\s+([A-Z0-9_]+)\s*;/g)) {
    guards.push([constants.get(match[1]), constants.get(match[2])]);
  }
  const returns = [...method[1].matchAll(/return\s+([A-Z0-9_]+)\s*;/g)];
  return {
    guards,
    // The guards return first; the final return is the fallback tier.
    fallback: constants.get(returns.at(-1)?.[1]),
    constants,
  };
}

function shellTier(rule, widthDp) {
  for (const [threshold, tier] of rule.guards) {
    if (widthDp >= threshold) return tier;
  }
  return rule.fallback;
}

function readRendererBreakpoints(source) {
  const signature = /fn\s+from_width\(width:\s*u32\)\s*->\s*Breakpoint\s*\{/.exec(source);
  assert.ok(signature, 'opurom-render layout.rs declares Breakpoint::from_width');
  // Walk brace depth from the signature so nested if/else bodies are captured
  // rather than ending at the first closing brace. The signature already
  // consumed the method's opening brace, so depth starts at one.
  let depth = 1;
  let end = signature.index + signature[0].length;
  for (; end < source.length; end += 1) {
    if (source[end] === '{') depth += 1;
    else if (source[end] === '}') {
      depth -= 1;
      if (depth === 0) break;
    }
  }
  const body = source.slice(signature.index + signature[0].length, end);
  const widths = [];
  for (const match of body.matchAll(/width\s*<\s*(\d+)\s*\{/g)) {
    widths.push(Number(match[1]));
  }
  return widths;
}

test('layoutTier keeps one column below 600 dp, two from 600 dp, three from 1200 dp', () => {
  const source = readFileSync(MAIN_ACTIVITY, 'utf8');
  const rule = readLayoutTierRule(source);

  // The guards are checked widest first, so the extracted rule is exact.
  assert.deepEqual(
    rule.guards,
    [[1200, 2], [600, 1]],
    'layoutTier reflows at 1200 dp to the three-column tier and at 600 dp to two',
  );
  assert.equal(rule.fallback, 0, 'the fallback tier is the single-column tier');

  // The extracted rule equals the required rule at every width.
  const reference = (widthDp) => (widthDp >= 1200 ? 2 : widthDp >= 600 ? 1 : 0);
  for (let width = 0; width <= 2000; width += 1) {
    assert.equal(shellTier(rule, width), reference(width), `width ${width}`);
  }

  // Spot checks at the tier edges.
  assert.equal(shellTier(rule, 599), 0);
  assert.equal(shellTier(rule, 600), 1);
  assert.equal(shellTier(rule, 1199), 1);
  assert.equal(shellTier(rule, 1200), 2);
  assert.equal(shellTier(rule, 2400), 2);
});

test('every shell breakpoint is exactly a renderer breakpoint', (t) => {
  let rendererSource;
  try {
    rendererSource = readFileSync(RENDERER_LAYOUT, 'utf8');
  } catch {
    t.skip(`needs ${RENDERER_LAYOUT} (the renderer's width tiers)`);
    return;
  }
  const breakpoints = readRendererBreakpoints(rendererSource);
  assert.deepEqual(breakpoints, [600, 900, 1200, 1600], 'renderer width tiers');

  const rule = readLayoutTierRule(readFileSync(MAIN_ACTIVITY, 'utf8'));
  const shellBreakpoints = rule.guards.map(([threshold]) => threshold);
  for (const threshold of shellBreakpoints) {
    assert.ok(
      breakpoints.includes(threshold),
      `shell breakpoint ${threshold} is not a renderer breakpoint`,
    );
  }

  // The shell steps up as the window grows, and never reflows off a renderer
  // boundary.
  for (let width = 0; width <= 2000; width += 1) {
    const previous = width === 0 ? width : width - 1;
    assert.ok(
      shellTier(rule, width) >= shellTier(rule, previous),
      `the shell tier must not step down at width ${width}`,
    );
    if (shellTier(rule, width) !== shellTier(rule, previous)) {
      assert.ok(breakpoints.includes(width),
        `the shell reflows at ${width}, which is not a renderer breakpoint`);
    }
  }
  assert.ok(breakpoints.includes(600), 'the shell reflows at the renderer 600 dp boundary');
  assert.ok(breakpoints.includes(1200), 'the shell reflows at the renderer 1200 dp boundary');
});

test('the tier decision drives the layout and the frame height at every tier', () => {
  const source = readFileSync(MAIN_ACTIVITY, 'utf8');

  // The rule is wired into the body builder, not left unused.
  assert.match(source, /buildBody\(layoutTier\(getResources\(\)\.getConfiguration\(\)\.screenWidthDp\)\)/);

  // The rail is a real navigation column at the three-column tier.
  assert.match(source, /buildNavRail\(\)/);
  assert.match(source, /navRow\(VIEWS\[i\], i\)/);

  // The frame card grows with the tier instead of staying at one height.
  const body = /private\s+int\s+frameHeight\(\)\s*\{([\s\S]*?)\}/.exec(source);
  assert.ok(body, 'frameHeight resolves the frame card height from the tier');
  const heights = [];
  for (const match of body[1].matchAll(/if\s*\(tier\s*==\s*TIER_[A-Z_]+\)\s*return\s+(\d+)\s*;/g)) {
    heights.push(Number(match[1]));
  }
  const fallback = body[1].replace(/if\s*\(tier\s*==\s*TIER_[A-Z_]+\)\s*return\s+\d+\s*;/g, '');
  const remaining = /return\s+(\d+)\s*;/.exec(fallback);
  assert.ok(remaining, 'frameHeight returns a height for the remaining tier');
  heights.push(Number(remaining[1]));
  assert.deepEqual(heights.sort((a, b) => a - b), [260, 300, 420],
    'frame card height is tier-appropriate');

  // The frame is re-rendered when its measured viewport changes.
  assert.match(source, /addOnLayoutChangeListener/);
  assert.match(source, /renderFrameIfSizeChanged\(\)/);
});

test('the docked action bar stays outside the scrollable content at every tier', () => {
  const source = readFileSync(MAIN_ACTIVITY, 'utf8');
  const scrollIndex = source.indexOf('scroll.addView(page');
  const dockIndex = source.indexOf('root.addView(dock');
  assert.ok(scrollIndex > 0, 'the scrollable page is added to the root');
  assert.ok(dockIndex > scrollIndex,
    'the docked action bar is added after, and outside, the ScrollView');
  assert.match(source, /scroll\.setFillViewport\(true\)/);
});
