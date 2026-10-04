import System from 'system';

import { to_relative, to_absolute, clamp_to_area, rect_string, rects_equal, monitor_containing }
    from '../lib/geometry.js';

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

const left = { x: -1920, y: 0, width: 1920, height: 1080 };
const right = { x: 0, y: 0, width: 2560, height: 1440 };

test('to_relative: subtracts monitor origin, including negative origins', () => {
    assert_equal(to_relative({ x: -1800, y: 100, width: 800, height: 600 }, left),
                 { x: 120, y: 100, width: 800, height: 600 });
});

test('to_absolute: inverse of to_relative', () => {
    const rect = { x: -1800, y: 100, width: 800, height: 600 };
    assert_equal(to_absolute(to_relative(rect, left), left), rect);
});

test('to_absolute: lands on a moved monitor', () => {
    assert_equal(to_absolute({ x: 10, y: 20, width: 5, height: 6 }, { x: 2560, y: 0, width: 1, height: 1 }),
                 { x: 2570, y: 20, width: 5, height: 6 });
});

test('clamp_to_area: rect inside the area is unchanged', () => {
    const rect = { x: 100, y: 50, width: 800, height: 600 };
    assert_equal(clamp_to_area(rect, right), rect);
});

test('clamp_to_area: y above the area is pulled down', () => {
    assert_equal(clamp_to_area({ x: 10, y: -40, width: 100, height: 100 }, { x: 0, y: 27, width: 1000, height: 700 }).y, 27);
});

test('clamp_to_area: oversized windows shrink to the area', () => {
    assert_equal(clamp_to_area({ x: 0, y: 0, width: 5000, height: 3000 }, right),
                 { x: 0, y: 0, width: 2560, height: 1440 });
});

test('clamp_to_area: top-left stays inside when the window starts beyond the far edge', () => {
    const r = clamp_to_area({ x: 9000, y: 9000, width: 100, height: 100 }, right);
    assert_equal([r.x, r.y], [2559, 1439]);
});

test('clamp_to_area: x left of the area is pulled in', () => {
    assert_equal(clamp_to_area({ x: -3000, y: 10, width: 100, height: 100 }, left).x, -1920);
});

test('rect_string and rects_equal', () => {
    assert_equal(rect_string({ x: 1, y: 2, width: 3, height: 4 }), '1,2+3x4');
    assert_equal(rects_equal({ x: 1, y: 2, width: 3, height: 4 }, { x: 1, y: 2, width: 3, height: 4 }), true);
    assert_equal(rects_equal({ x: 1, y: 2, width: 3, height: 4 }, { x: 1, y: 2, width: 3, height: 5 }), false);
});

test('monitor_containing: picks by center, falls back to nearest', () => {
    assert_equal(monitor_containing({ x: -500, y: 0, width: 200, height: 200 }, [right, left]), 1);
    assert_equal(monitor_containing({ x: 100, y: 0, width: 200, height: 200 }, [right, left]), 0);
    assert_equal(monitor_containing({ x: -5000, y: 0, width: 100, height: 100 }, [right, left]), 1);
});

if (failures) {
    print(`${failures} test(s) failed`);
    System.exit(1);
}
