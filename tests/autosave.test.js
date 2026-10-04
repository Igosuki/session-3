import System from 'system';

import { save_skip_reason, backup_copies, expand_path, restore_level_index }
    from '../lib/policy.js';

let failures = 0;

function test(name, fn) {
    try {
        fn();
        print(`ok   ${name}`);
    } catch (e) {
        failures++;
        print(`FAIL ${name}: ${e.message}`);
    }
}

function assert_equal(actual, expected) {
    const a = JSON.stringify(actual), e = JSON.stringify(expected);
    if (a !== e) throw new Error(`expected ${e}, got ${a}`);
}

const idle = { enabled: true, busy: false, restore_pending: false };

test('skip: disabled, busy and pending restore', () => {
    assert_equal(save_skip_reason({ ...idle, enabled: false }), 'auto-save disabled');
    assert_equal(save_skip_reason({ ...idle, busy: true }), 'restore in progress');
    assert_equal(save_skip_reason({ ...idle, restore_pending: true }), 'login restore not yet complete');
});

test('skip: no snapshot needed for early checks', () => {
    assert_equal(save_skip_reason(idle), null);
});

test('skip: zero windows', () => {
    assert_equal(save_skip_reason({ ...idle, count: 0, prev_count: 5 }), 'no windows');
});

test('skip: count below half of previous', () => {
    assert_equal(save_skip_reason({ ...idle, count: 4, prev_count: 10 }), 'window count fell from 10 to 4');
});

test('save: exactly half, growth and first tick', () => {
    assert_equal(save_skip_reason({ ...idle, count: 5, prev_count: 10 }), null);
    assert_equal(save_skip_reason({ ...idle, count: 12, prev_count: 10 }), null);
    assert_equal(save_skip_reason({ ...idle, count: 1, prev_count: null }), null);
});

test('backup_copies: oldest generation first, current file last', () => {
    assert_equal(backup_copies('/s.json'), [
        { from: '/s.json.2', to: '/s.json.3' },
        { from: '/s.json.1', to: '/s.json.2' },
        { from: '/s.json', to: '/s.json.1' },
    ]);
    assert_equal(backup_copies('/s.json', 1), [{ from: '/s.json', to: '/s.json.1' }]);
});

test('expand_path', () => {
    assert_equal(expand_path('~/a/b', '/home/u'), '/home/u/a/b');
    assert_equal(expand_path('~', '/home/u'), '/home/u');
    assert_equal(expand_path('/x/~y', '/home/u'), '/x/~y');
    assert_equal(expand_path('~other/x', '/home/u'), '~other/x');
});

test('restore_level_index', () => {
    assert_equal(['existing', 'matching', 'missing', 'bogus'].map(restore_level_index), [0, 1, 2, 2]);
});

if (failures) System.exit(1);
