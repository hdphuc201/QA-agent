import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { makeTextRedactor, redactEvent, redactTranscript } from '../../scripts/smoke/redact.mjs';

const redact = makeTextRedactor({ home: 'C:\\Users\\Jane Doe', user: 'jdoe' });

describe('evidence redaction', () => {
  test('home directory in native, forward-slash and JSON-escaped forms', () => {
    assert.equal(
      redact('cwd C:\\Users\\Jane Doe\\AppData\\Local\\Temp\\x'),
      'cwd <HOME>\\AppData\\Local\\Temp\\x',
    );
    assert.equal(redact('C:/Users/Jane Doe/proj'), '<HOME>/proj');
    assert.equal(redact('"C:\\\\Users\\\\Jane Doe\\\\proj"'), '"<HOME>\\\\proj"');
    assert.equal(redact('c:\\users\\jane doe\\x'), '<HOME>\\x');
  });

  test('user name as a whole word only', () => {
    assert.equal(redact('owner jdoe ran it'), 'owner <USER> ran it');
    assert.equal(redact('jdoes and xjdoe stay'), 'jdoes and xjdoe stay');
  });

  test('init keeps qa-agent entries and redacts unrelated plugins, servers, skills and tools', () => {
    const init = {
      type: 'system',
      subtype: 'init',
      tools: [
        'Bash',
        'mcp__plugin_qa-agent_playwright__browser_navigate',
        'mcp__other_server__tool',
      ],
      skills: ['debug', 'qa-agent:discover', 'other-plugin:skill'],
      slash_commands: ['qa-agent:plan', 'other:cmd', 'compact', 'mcp__other_server__prompt'],
      mcp_servers: [
        { name: 'plugin:qa-agent:playwright', status: 'connected' },
        { name: 'other-server', status: 'connected' },
      ],
      plugins: [
        { name: 'qa-agent', path: 'D:\\repo' },
        { name: 'other-plugin', path: 'C:\\Users\\Jane Doe\\.claude\\plugins\\x' },
      ],
    };
    const out = redactEvent(init);
    assert.deepEqual(out.tools, [
      'Bash',
      'mcp__plugin_qa-agent_playwright__browser_navigate',
      '<1 unrelated entries redacted>',
    ]);
    assert.deepEqual(out.skills, ['debug', 'qa-agent:discover', '<1 unrelated entries redacted>']);
    assert.deepEqual(out.slash_commands, [
      'qa-agent:plan',
      'compact',
      '<2 unrelated entries redacted>',
    ]);
    assert.deepEqual(out.mcp_servers, [
      { name: 'plugin:qa-agent:playwright', status: 'connected' },
      { name: '<redacted>', status: 'connected' },
    ]);
    assert.deepEqual(out.plugins, [
      { name: 'qa-agent', path: 'D:\\repo' },
      { name: '<1 unrelated plugin(s) redacted>' },
    ]);
    assert.equal(init.plugins.length, 2, 'input is not mutated');
  });

  test('hook output is removed, other events are untouched', () => {
    const hook = {
      type: 'system',
      subtype: 'hook_response',
      output: 'secret-ish',
      stdout: 'x',
      stderr: '',
      exit_code: 0,
    };
    assert.deepEqual(redactEvent(hook), {
      ...hook,
      output: '<user hook output redacted>',
      stdout: '<user hook output redacted>',
    });
    const msg = { type: 'assistant', message: { content: [{ type: 'text', text: 'hi' }] } };
    assert.deepEqual(redactEvent(msg), msg);
  });

  test('transcript lines are redacted and remain valid JSON', () => {
    const jsonl = [
      JSON.stringify({
        type: 'system',
        subtype: 'init',
        cwd: 'C:\\Users\\Jane Doe\\tmp',
        plugins: [],
      }),
      JSON.stringify({ type: 'result', result: 'token=qa-smoke-abc' }),
    ].join('\n');
    const lines = redactTranscript(jsonl, redact)
      .split('\n')
      .map((l) => JSON.parse(l));
    assert.equal(lines[0].cwd, '<HOME>\\tmp');
    assert.equal(lines[1].result, 'token=qa-smoke-abc');
  });
});
