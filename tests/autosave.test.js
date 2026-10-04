import System from 'system';

import { save_skip_reason, backup_copies, expand_path, restore_level_index,
         new_high_water, track_high_water, should_rotate, count_saved_windows, restore_summary }
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
    assert_equal(['existing', 'matching', 'missing'].map(restore_level_index), [0, 1, 2]);
    let message = null;
    try { restore_level_index('bogus'); } catch (e) { message = e.message; }
    assert_equal(message, 'Unknown restore level: bogus');
});

test('skip: paused', () => {
    assert_equal(save_skip_reason({ ...idle, paused: 'bad file' }), 'auto-save paused: bad file');
});

test('high water: rises at once, ignores zero', () => {
    let s = track_high_water(new_high_water(4), 9);
    assert_equal(s.high, 9);
    assert_equal(track_high_water(s, 0), s);
});

test('high water: drops only after three equal lower ticks', () => {
    let s = new_high_water(10);
    s = track_high_water(s, 3);
    assert_equal(s.high, 10);
    s = track_high_water(s, 3);
    assert_equal(s.high, 10);
    s = track_high_water(s, 3);
    assert_equal(s.high, 3);
});

test('high water: differing or recovering ticks restart the streak', () => {
    let s = new_high_water(10);
    s = track_high_water(s, 3);
    s = track_high_water(s, 4);
    s = track_high_water(s, 4);
    assert_equal(s.high, 10);
    s = track_high_water(s, 3);
    s = track_high_water(s, 3);
    s = track_high_water(s, 10);
    s = track_high_water(s, 3);
    assert_equal(s.high, 10);
});

test('high water: guard sees the mark, a deliberate close resumes saving on the third tick', () => {
    let s = new_high_water(10);
    const reasons = [];
    for (let i = 0; i < 3; i++) {
        s = track_high_water(s, 3);
        reasons.push(save_skip_reason({ ...idle, count: 3, prev_count: s.high }));
    }
    assert_equal(reasons, ['window count fell from 10 to 3', 'window count fell from 10 to 3', null]);
});

test('should_rotate: manual always, quiet only when newest backup is missing or old', () => {
    assert_equal(should_rotate({ quiet: false, age_seconds: 5 }), true);
    assert_equal(should_rotate({ quiet: true, age_seconds: null }), true);
    assert_equal(should_rotate({ quiet: true, age_seconds: 3600 }), false);
    assert_equal(should_rotate({ quiet: true, age_seconds: 3601 }), true);
});

test('count_saved_windows: ignores opt, tolerates junk', () => {
    assert_equal(count_saved_windows({ 1: {}, 2: {}, opt: {} }), 2);
    assert_equal([null, 'x', [1, 2], undefined].map(count_saved_windows), [0, 0, 0, 0]);
});

test('restore_summary: omits zero parts', () => {
    assert_equal(restore_summary({ total: 5, restored: 5 }), 'Restored 5 of 5 windows');
    assert_equal(restore_summary({ total: 7, restored: 3, not_found: 2, failed: 1, unlaunchable: 1 }),
        "Restored 3 of 7 windows; 2 not found; 1 failed to launch; 1 can't launch");
});

if (failures) System.exit(1);
