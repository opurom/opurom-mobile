// The native shell's controls must expose the same five interaction states as
// the design-system reference. ColorStateList selection is pure view state, so
// the state array and the resolved brand ramp are checked against the real
// Java source without an emulator.
'use strict';

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE = readFileSync(path.join(
  ROOT, 'android', 'app', 'src', 'main', 'java', 'org', 'opurom', 'mobile', 'MainActivity.java'),
  'utf8');

test('controlColors declares all five interaction states in priority order', () => {
  const body = /private\s+static\s+ColorStateList\s+controlColors\(([\s\S]*?)\n    \}/.exec(SOURCE);
  assert.ok(body, 'a single controlColors helper owns the state table');
  const states = body[1];
  for (const attr of ['state_enabled', 'state_pressed', 'state_focused', 'state_hovered']) {
    assert.match(states, new RegExp(`android\\.R\\.attr\\.${attr}`), `${attr} is declared`);
  }
  // Disabled wins over every other state: its negative attr is first.
  const disabled = states.indexOf('-android.R.attr.state_enabled');
  const pressed = states.indexOf('android.R.attr.state_pressed');
  assert.ok(disabled >= 0 && disabled < pressed, 'disabled takes precedence over pressed');
  assert.match(states, /int\[\]\s*\{disabled,\s*active,\s*focused,\s*hovered,\s*normal\}/,
    'the five colors map to the five states');
});

test('buttons and their labels both resolve through the five-state table', () => {
  const action = /private\s+LinearLayout\s+actionButton\(([\s\S]*?)\n    \}/.exec(SOURCE);
  assert.ok(action, 'actionButton builds the native controls');
  const body = action[1];
  const uses = [...body.matchAll(/controlColors\(/g)].length;
  assert.ok(uses >= 3, 'primary fill, secondary fill and label ink all use the table');
  assert.match(body, /setFocusable\(true\)/, 'focus is reachable for keyboard navigation');
  assert.match(body, /setClickable\(true\)/, 'the control remains interactive');
});

test('the light palette matches the measured design-system ramp', () => {
  const palette = /private\s+void\s+resolvePalette\(([\s\S]*?)\n    \}/.exec(SOURCE);
  assert.ok(palette);
  const light = palette[1].split('} else {')[1] ?? '';
  const expected = {
    background: '0xFFF4F6F9',
    card: '0xFFFFFFFF',
    text: '0xFF132C5A',
    accent: '0xFF0A71FC',
    brandTop: '0xFF0DB2FF',
    brandBottom: '0xFF0A71FC',
    positive: '0xFF1FB14C',
  };
  for (const [field, value] of Object.entries(expected)) {
    assert.match(light, new RegExp(`\\b${field}\\s*=\\s*${value};`),
      `${field} uses the measured reference value ${value}`);
  }
});
