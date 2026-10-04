import System from 'system';

import { is_self_managed } from '../lib/apps.js';

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

const list = ['firefox', 'google-chrome', 'TradingView', 'dev.zed.Zed',
              'jetbrains-webstorm', 'install4j-jclient-LoginFrame'];

test('exact class matches case-insensitively', () => {
    assert_equal(is_self_managed('Google-chrome', null, list), true);
    assert_equal(is_self_managed('tradingview', null, list), true);
});

test('snap name_name class matches bare entry', () => {
    assert_equal(is_self_managed('firefox_firefox', null, list), true);
    assert_equal(is_self_managed(null, 'firefox_firefox.desktop', list), true);
});

test('snap collapse requires identical halves', () => {
    assert_equal(is_self_managed('firefox_nightly', null, list), false);
});

test('app id matches without .desktop suffix', () => {
    assert_equal(is_self_managed('other', 'google-chrome.desktop', list), true);
    assert_equal(is_self_managed('other', 'dev.zed.Zed.desktop', list), true);
});

test('reverse-DNS entry matches bare class by last segment', () => {
    assert_equal(is_self_managed('Zed', null, list), true);
});

test('bare entry matches reverse-DNS app id by last segment', () => {
    assert_equal(is_self_managed(null, 'org.mozilla.firefox', list), true);
});

test('dev.zed.Delta does not match dev.zed.Zed', () => {
    assert_equal(is_self_managed('dev.zed.Delta', 'dev.zed.Delta.desktop', list), false);
});

test('substrings and prefixes do not match', () => {
    assert_equal(is_self_managed('firefox-esr', null, list), false);
    assert_equal(is_self_managed('jetbrains-webstorm-eap', null, list), false);
});

test('missing class and app id never match', () => {
    assert_equal(is_self_managed(null, undefined, list), false);
    assert_equal(is_self_managed('firefox', null, []), false);
});

if (failures) {
    print(`${failures} test(s) failed`);
    System.exit(1);
}
