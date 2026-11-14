// The native shell maps the loaded IR's theme.tokens.* and theme.accent onto
// its chrome colours through ThemeTokens.java (a pure reader south of the JNI
// frame boundary). The Java is compiled on hosts with an Android SDK; this
// test pins the mapping, its documented fallbacks and the fontMetrics reader by
// (a) asserting the real Java source and (b) running a faithful JS model of the
// same algorithm against every packaged IR asset and the measured defaults.
'use strict';

import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const JAVA_DIR = path.join(ROOT, 'android', 'app', 'src', 'main', 'java', 'org', 'opurom', 'mobile');
const SOURCE = readFileSync(path.join(JAVA_DIR, 'ThemeTokens.java'), 'utf8');
const ACTIVITY = readFileSync(path.join(JAVA_DIR, 'MainActivity.java'), 'utf8');
const ASSETS = path.join(ROOT, 'android', 'app', 'src', 'main', 'assets');

// Measured semantic defaults from opurom-spec/IR_ADDITIONS.md.
const DEFAULTS = {
  primary: 0xFF0A71FC,
  secondary: 0xFF0DB2FF,
  success: 0xFF1FB14C,
  warning: 0xFFFD960E,
  error: 0xFFF62B35,
  info: 0xFF0A71FC,
};

// ---------------------------------------------------------------------------
// Faithful JS model of ThemeTokens.resolve: same top-level tokens scan, same
// #RRGGBB/#AARRGGBB parsing, same per-role fallback to the measured default.
// ---------------------------------------------------------------------------
function matchingBrace(text, open) {
  let depth = 0;
  let inString = false;
  for (let i = open; i < text.length; i += 1) {
    const c = text[i];
    if (inString) {
      if (c === '\\') i += 1;
      else if (c === '"') inString = false;
    } else if (c === '"') {
      inString = true;
    } else if (c === '{') {
      depth += 1;
    } else if (c === '}') {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function tokens(ir) {
  const out = {};
  const theme = ir.indexOf('"theme"');
  if (theme < 0) return out;
  const themeBrace = ir.indexOf('{', theme);
  if (themeBrace < 0) return out;
  const themeEnd = matchingBrace(ir, themeBrace);
  if (themeEnd < 0) return out;
  const start = ir.indexOf('"tokens"', themeBrace);
  if (start < 0 || start > themeEnd) return out;
  const brace = ir.indexOf('{', start);
  if (brace < 0) return out;
  const end = matchingBrace(ir, brace);
  if (end < 0) return out;
  const body = ir.slice(brace + 1, end);
  const re = /"([A-Za-z0-9_-]+)"\s*:\s*"(#[0-9A-Fa-f]{6,8}|[A-Za-z]+)"/g;
  let m;
  while ((m = re.exec(body)) !== null) out[m[1]] = m[2];
  return out;
}

function parseColor(value, fallback) {
  if (value == null) return fallback;
  const text = value.trim();
  if (text.startsWith('#')) {
    const hex = text.slice(1);
    if (!/^[0-9A-Fa-f]+$/.test(hex)) return fallback;
    const packed = Number.parseInt(hex, 16);
    if (packed > 0xFFFFFFFF) return fallback;
    if (hex.length === 6) return (0xFF000000 | packed) >>> 0;
    if (hex.length === 8) return packed >>> 0;
    return fallback;
  }
  const named = { white: 0xFFFFFFFF, black: 0xFF000000, transparent: 0 };
  return Object.prototype.hasOwnProperty.call(named, text.toLowerCase())
    ? named[text.toLowerCase()] : fallback;
}

function resolve(ir) {
  const t = tokens(ir);
  const accentMatch = /"accent"\s*:\s*"(#[0-9A-Fa-f]{6,8}|[A-Za-z]+)"/.exec(ir);
  return {
    primary: parseColor(t.primary, 0),
    secondary: parseColor(t.secondary, 0),
    success: parseColor(t.success, 0),
    warning: parseColor(t.warning, 0),
    error: parseColor(t.error, 0),
    info: parseColor(t.info, 0),
    accent: parseColor(accentMatch ? accentMatch[1] : null, 0),
  };
}

// ---------------------------------------------------------------------------
test('ThemeTokens declares the six measured semantic defaults', () => {
  const expected = {
    DEFAULT_PRIMARY: DEFAULTS.primary,
    DEFAULT_SECONDARY: DEFAULTS.secondary,
    DEFAULT_SUCCESS: DEFAULTS.success,
    DEFAULT_WARNING: DEFAULTS.warning,
    DEFAULT_ERROR: DEFAULTS.error,
    DEFAULT_INFO: DEFAULTS.info,
  };
  for (const [field, value] of Object.entries(expected)) {
    const hex = `0x${value.toString(16).toUpperCase().padStart(8, '0')}`;
    assert.match(SOURCE, new RegExp(`static final int ${field} = ${hex};`),
      `${field} keeps the measured reference value ${hex}`);
  }
});

test('the token reader is a pure function of the IR text, absent tokens are 0', () => {
  // resolve() maps every role through parseColor with a 0 (absent) fallback so
  // the caller keeps its mode-measured palette when no token is authored.
  for (const role of ['primary', 'secondary', 'success', 'warning', 'error', 'info']) {
    assert.match(SOURCE, new RegExp(`parseColor\\(tokens\\.get\\("${role}"\\), 0\\)`),
      `${role} resolves to 0 when the token is absent`);
  }
  // The accent is optional too: 0 when absent so the caller keeps its mode colour.
  assert.match(SOURCE, /parseColor\(firstMatch\(ACCENT, ir\), 0\)/,
    'a missing accent resolves to 0, not a hardcoded default');
  // A missing token never yields a malformed ARGB int: 6 hex -> opaque, 8 -> as-is.
  assert.match(SOURCE, /if \(length == 6\) return 0xFF000000 \| \(int\) packed;/);
  assert.match(SOURCE, /if \(length == 8\) return \(int\) packed;/);
});

test('the reader scans only the top-level tokens object', () => {
  assert.match(SOURCE, /int start = ir\.indexOf\("\\"tokens\\"", themeBrace\);/,
    'the tokens scan is bounded to the theme object');
  assert.match(SOURCE, /matchingBrace\(ir, brace\)/,
    'the tokens object is bounded by brace matching, not a greedy regex');
});

test('an IR with no semantic token resolves every role to 0 (keep mode palette)', () => {
  const plain = '{"theme":{"accent":"#097FEB","mode":"light"}}';
  const palette = resolve(plain);
  assert.deepEqual(palette, {
    primary: 0, secondary: 0, success: 0, warning: 0, error: 0, info: 0,
    accent: 0xFF097FEB,
  });
  // The packaged IRs declare only tokens.stage, so no semantic role is authored
  // and the Activity keeps its measured (mode-aware) palette.
  for (const name of readdirSync(ASSETS).filter((n) => n.endsWith('.opuir.json'))) {
    const text = readFileSync(path.join(ASSETS, name), 'utf8');
    const theme = JSON.parse(text).theme;
    const model = resolve(text);
    assert.doesNotThrow(() => JSON.parse(text), `${name} stays valid JSON`);
    for (const role of ['primary', 'secondary', 'success', 'warning', 'error', 'info']) {
      assert.equal(model[role], 0,
        `${name} authors no ${role} token, so the mode palette is kept`);
    }
    if (theme.accent) {
      assert.equal(model.accent, (0xFF000000 | Number.parseInt(theme.accent.slice(1), 16)) >>> 0,
        `${name} accent is read from theme.accent`);
    }
  }
});

test('authored semantic tokens are read, absent ones stay 0', () => {
  const ir = JSON.stringify({
    theme: {
      accent: '#4F46E5',
      fontMetrics: 'proportional',
      tokens: { success: '#22C55E', error: '#B91C1C', stage: '#EEF0F8' },
    },
  });
  const palette = resolve(ir);
  assert.equal(palette.success, 0xFF22C55E, 'success token is read');
  assert.equal(palette.error, 0xFFB91C1C, 'error token is read');
  assert.equal(palette.warning, 0, 'absent warning stays 0');
  assert.equal(palette.info, 0, 'absent info stays 0');
  assert.equal(palette.primary, 0, 'absent primary stays 0');
  assert.equal(palette.secondary, 0, 'absent secondary stays 0');
  assert.equal(palette.accent, 0xFF4F46E5, 'accent comes from theme.accent');
});

test('a token declared in a nested object is not mistaken for a theme token', () => {
  const ir = '{"theme":{"accent":"#097FEB"},"tree":{"props":{"tokens":{"success":"#111111"}}}}';
  assert.equal(resolve(ir).success, 0,
    'only the theme object\'s tokens are read');
});

test('the Activity wires the resolved palette onto native chrome', () => {
  assert.match(ACTIVITY, /applyThemeTokens\(new String\(graphicsIr, StandardCharsets\.UTF_8\)\)/,
    'onCreate resolves tokens from the loaded IR');
  const apply = /private void applyThemeTokens\(String ir\) \{([\s\S]*?)\n    \}/.exec(ACTIVITY);
  assert.ok(apply, 'applyThemeTokens owns the mapping');
  const text = apply[1];
  assert.match(text, /if \(theme\.success != 0\) positive = theme\.success;/,
    'the positive/status ink uses the success token only when authored');
  assert.match(text, /if \(theme\.accent != 0\) \{[\s\S]*?accent = theme\.accent;/,
    'the authored accent drives the accent chrome, guarded against absence');
});

test('theme.fontMetrics selects proportional vs fixed native type', () => {
  const pattern = /FONT_METRICS\s*=\s*java\.util\.regex\.Pattern\.compile\("((?:\\.|[^"\\])*)"\)/
    .exec(ACTIVITY);
  assert.ok(pattern, 'a single FONT_METRICS pattern owns the token');
  const re = new RegExp(pattern[1].replace(/\\(.)/g, '$1'));
  assert.ok(re.test('"fontMetrics":"proportional"'));
  assert.ok(re.test('"fontMetrics":  "proportional"'));
  assert.ok(!re.test('"fontMetrics":"fixed"'), 'fixed is not proportional');
  assert.match(ACTIVITY, /captionFace = themeFontMetrics\(ir\) \? "sans-serif" : "monospace";/,
    'proportional chooses the sans-serif face, fixed the monospace one');
});
