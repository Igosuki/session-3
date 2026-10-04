import System from 'system';

import { levenshtein, hungarian_match, compare_command_commstr, args_to_command }
    from '../lib/match.js';

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

function sorted(obj) {
    return Object.fromEntries(Object.entries(obj).sort(([a], [b]) => a.localeCompare(b)));
}

function assert_equal(actual, expected) {
    const a = JSON.stringify(actual), e = JSON.stringify(expected);
    if (a !== e) throw new Error(`expected ${e}, got ${a}`);
}

test('levenshtein: identical strings score 1', () => {
    assert_equal(levenshtein('abc', 'abc'), 1);
});

test('levenshtein: fully different strings score 0', () => {
    assert_equal(levenshtein('abc', 'xyz'), 0);
});

test('levenshtein: one edit in four characters', () => {
    assert_equal(levenshtein('abcd', 'abce'), 0.75);
});

test('levenshtein: null is treated as empty', () => {
    assert_equal(levenshtein(null, 'abcd'), 0);
});

test('hungarian_match: picks the best total, not the greedy choice', () => {
    const [score, map] = hungarian_match({
        r1: { c1: 10, c2: 9 },
        r2: { c1: 9 },
    });
    assert_equal(score, 18);
    assert_equal(sorted(map), { r1: 'c2', r2: 'c1' });
});

test('hungarian_match: more restore windows than current windows pads with NULL#n', () => {
    const [score, map] = hungarian_match({
        r1: { c1: 10 },
        r2: { c1: 8 },
        r3: { c1: 7 },
    });
    // Padded rows have cost -1, so each NULL assignment adds 1 to the score:
    assert_equal(score, 12);
    assert_equal(sorted(map), { r1: 'c1', r2: 'NULL#1', r3: 'NULL#2' });
});

test('hungarian_match: more current windows than restore windows', () => {
    const [score, map] = hungarian_match({
        r1: { c1: 6, c2: 12 },
    });
    assert_equal(score, 12);
    assert_equal(sorted(map), { r1: 'c2' });
});

test('args_to_command: plain arguments are space-joined', () => {
    assert_equal(args_to_command(['firefox', '--new-window']), 'firefox --new-window');
});

test('args_to_command: arguments with whitespace or quotes are quoted', () => {
    assert_equal(args_to_command(['app', 'a b', 'say "hi"']), 'app "a b" "say \\"hi\\""');
});

test('compare_command_commstr: exact command matches', () => {
    assert_equal(compare_command_commstr('gedit --new-window', 'gedit --new-window'), true);
});

test('compare_command_commstr: %U accepts zero or many arguments', () => {
    assert_equal(compare_command_commstr('firefox %U', 'firefox'), true);
    assert_equal(compare_command_commstr('firefox %U', 'firefox a b'), true);
});

test('compare_command_commstr: %u accepts a single optional argument', () => {
    assert_equal(compare_command_commstr('app %u', 'app a'), true);
    assert_equal(compare_command_commstr('app %u', 'app a b'), false);
});

test('compare_command_commstr: differing commands do not match', () => {
    assert_equal(compare_command_commstr('gedit %F', 'nano file'), false);
});

if (failures) {
    print(`${failures} test(s) failed`);
    System.exit(1);
}
