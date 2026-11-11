import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { detectProject } from '../lib/detect.mjs';
import { parseResetTime } from '../lib/accounts.mjs';

function project(files = {}, directories = []) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ah-unit-'));
  for (const [name, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(root, name), content);
  }
  for (const name of directories) fs.mkdirSync(path.join(root, name));
  return root;
}

const nodePackage = JSON.stringify({ scripts: { test: 'node --test' } });

for (const { name, files, directories, expected } of [
  {
    name: 'empty directory',
    files: {},
    expected: { kinds: [], test: null, link: [] },
  },
  {
    name: 'node with a real test script',
    files: { 'package.json': nodePackage },
    expected: { kinds: ['node'], test: 'npm test', link: [] },
  },
  {
    name: 'node without scripts',
    files: { 'package.json': '{}' },
    expected: { kinds: ['node'], test: null, link: [] },
  },
  {
    name: 'node without a test script',
    files: { 'package.json': JSON.stringify({ scripts: { start: 'node index.mjs' } }) },
    expected: { kinds: ['node'], test: null, link: [] },
  },
  {
    name: 'node with the default placeholder test script',
    files: {
      'package.json': JSON.stringify({ scripts: { test: 'echo "Error: no test specified" && exit 1' } }),
    },
    expected: { kinds: ['node'], test: null, link: [] },
  },
  {
    name: 'pnpm lockfile',
    files: { 'package.json': nodePackage, 'pnpm-lock.yaml': '' },
    expected: { kinds: ['node'], test: 'pnpm test', link: [] },
  },
  {
    name: 'yarn lockfile',
    files: { 'package.json': nodePackage, 'yarn.lock': '' },
    expected: { kinds: ['node'], test: 'yarn test', link: [] },
  },
  {
    name: 'pnpm takes precedence when both lockfiles exist',
    files: { 'package.json': nodePackage, 'pnpm-lock.yaml': '', 'yarn.lock': '' },
    expected: { kinds: ['node'], test: 'pnpm test', link: [] },
  },
  {
    name: 'node_modules is selected for linking',
    files: { 'package.json': nodePackage },
    directories: ['node_modules'],
    expected: { kinds: ['node'], test: 'npm test', link: ['node_modules'] },
  },
  {
    name: 'cargo project',
    files: { 'Cargo.toml': '' },
    expected: { kinds: ['rust'], test: 'cargo test', link: [] },
  },
  {
    name: 'go project',
    files: { 'go.mod': 'module example.com/project\n' },
    expected: { kinds: ['go'], test: 'go test ./...', link: [] },
  },
  {
    name: 'Makefile with a test target',
    files: { Makefile: 'all:\n\techo build\n\ntest:\n\techo tests\n' },
    expected: { kinds: [], test: 'make test', link: [] },
  },
  {
    name: 'Makefile without a test target',
    files: { Makefile: 'test-unit:\n\techo tests\n' },
    expected: { kinds: [], test: null, link: [] },
  },
]) {
  test(`detectProject: ${name}`, () => {
    assert.deepEqual(detectProject(project(files, directories)), expected);
  });
}

// Numeric date constructors use local time, matching the parser in any timezone.
for (const { name, message, now, expected } of [
  {
    name: '12 AM is midnight',
    message: 'try again at 12:00 AM',
    now: new Date(2026, 0, 15, 23, 0),
    expected: new Date(2026, 0, 16, 0, 0),
  },
  {
    name: '12 PM is noon',
    message: 'try again at 12:00 PM',
    now: new Date(2026, 0, 15, 8, 0),
    expected: new Date(2026, 0, 15, 12, 0),
  },
  {
    name: 'AM time remains in the morning',
    message: 'try again at 7:58 AM',
    now: new Date(2026, 0, 15, 6, 0, 12, 345),
    expected: new Date(2026, 0, 15, 7, 58),
  },
  {
    name: 'PM time converts to the afternoon',
    message: 'Usage limit reached; try again at 7:58 PM.',
    now: new Date(2026, 0, 15, 8, 0),
    expected: new Date(2026, 0, 15, 19, 58),
  },
  {
    name: 'a time that has passed rolls over to tomorrow',
    message: 'try again at 7:58 PM',
    now: new Date(2026, 0, 31, 20, 0),
    expected: new Date(2026, 1, 1, 19, 58),
  },
  {
    name: 'an exact current time rolls over to tomorrow',
    message: 'try again at 7:58 PM',
    now: new Date(2026, 0, 15, 19, 58),
    expected: new Date(2026, 0, 16, 19, 58),
  },
  {
    name: 'a weekly/monthly limit gives a full date (month, day with suffix, year)',
    message: 'You’ve hit your usage limit. Upgrade to Plus to continue using Codex, or try again at Dec 4th, 2026 2:48 PM.',
    now: new Date(2026, 10, 11, 10, 0),
    expected: new Date(2026, 11, 4, 14, 48),
  },
  {
    name: 'a full date without suffix and with 12 AM',
    message: 'try again at January 2, 2027 12:05 AM',
    now: new Date(2026, 10, 11, 10, 0),
    expected: new Date(2027, 0, 2, 0, 5),
  },
]) {
  test(`parseResetTime: ${name}`, () => {
    const original = now.getTime();
    assert.equal(parseResetTime(message, now), expected.toISOString());
    assert.equal(now.getTime(), original, 'the supplied date is not mutated');
  });
}

for (const message of ['No reset time available', '', null, undefined]) {
  test(`parseResetTime: falls back to one hour for ${JSON.stringify(message)}`, () => {
    const now = new Date(2026, 0, 15, 23, 30, 12, 345);
    assert.equal(parseResetTime(message, now), new Date(now.getTime() + 3_600_000).toISOString());
  });
}
